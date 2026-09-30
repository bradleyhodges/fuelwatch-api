import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare, NoOpLog } from "miniflare";

const output = fileURLToPath(
    new URL("../dist/test/enrichment.cjs", import.meta.url),
);
await build({
    stdin: {
        contents:
            'export * from "./src/enrichment"; export * from "./src/station"; export {default as handler} from "./src/index";',
        resolveDir: fileURLToPath(new URL("..", import.meta.url)),
        loader: "ts",
    },
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
});
const api = createRequire(import.meta.url)(output);
const migration = await readFile(
    new URL("../migrations/0001_station_enrichment.sql", import.meta.url),
    "utf8",
);
const now = Date.parse("2026-09-29T08:00:00Z");
const item = {
    title: "Example",
    description: "",
    brand: "Example",
    date: "2026-09-29",
    price: "185.9",
    "trading-name": "Example Station",
    location: "PERTH",
    address: "1 Test Road",
    phone: null,
    latitude: "-31.95",
    longitude: "115.86",
    "site-features": "",
    restrictions: "",
};
const xml = `<rss version="2.0"><channel><title>FuelWatch</title><item>${Object.entries(
    item,
)
    .map(([key, value]) => `<${key}>${value ?? ""}</${key}>`)
    .join("")}</item></channel></rss>`;
const google = {
    id: "test_place",
    displayName: { text: "Example Station" },
    types: ["gas_station"],
    businessStatus: "OPERATIONAL",
    location: { latitude: -31.95, longitude: 115.86 },
    addressComponents: [
        { types: ["country"], shortText: "AU" },
        { types: ["administrative_area_level_1"], shortText: "WA" },
        { types: ["postal_code"], longText: "6000" },
    ],
};
let worker, db, env, googleCalls;
beforeEach(async () => {
    worker = new Miniflare(
        convertV4MiniflareOptions({
            modules: true,
            script: 'export default { fetch() { return new Response("ok") } }',
            compatibilityDate: "2026-09-29",
            cf: false,
            log: new NoOpLog(),
            d1Databases: { FUELWATCH_DB: "test-enrichment" },
        }),
    );
    db = await worker.getD1Database("FUELWATCH_DB");
    await db.batch(
        migration
            .replace(/--[^\n]*/g, "")
            .split(";")
            .filter((sql) => sql.trim())
            .map((sql) => db.prepare(sql)),
    );
    env = {
        FUELWATCH_DB: db,
        FUELWATCH_URL: "https://source.example/rss",
        GOOGLE_MAPS_API_KEY: "test-secret",
        GOOGLE_DAILY_REQUEST_LIMIT: "100",
        ENRICHMENT_BATCH_SIZE: "10",
        ENRICHMENT_REFRESH_DAYS: "7",
    };
    googleCalls = 0;
});
afterEach(async () => {
    await worker.dispose();
});
const fetcher = async (url) => {
    if (url.hostname === "source.example") return new Response(xml);
    googleCalls++;
    return Response.json(
        url.pathname.endsWith("searchText") ? { places: [google] } : google,
    );
};

test("scheduled refresh populates D1 once and public reads never make paid lookups", async () => {
    await api.refreshEnrichment(env, { now, fetcher });
    const cached = await api.readEnrichments(db, [item], now + 5000);
    assert.equal(cached.get(api.stationKey(item)).postcode, "6000");
    assert.equal(googleCalls, 1);
    await api.refreshEnrichment(env, { now: now + 15 * 60_000, fetcher });
    assert.equal(googleCalls, 1);
});

test("a held lease prevents concurrent refresh and extra spending", async () => {
    await db
        .prepare(
            "UPDATE enrichment_refresh SET owner = 'other', lease_until = ? WHERE id = 1",
        )
        .bind(now + 120_000)
        .run();
    await api.refreshEnrichment(env, { now, fetcher });
    assert.equal(googleCalls, 0);
});

test("FuelWatch missing-phone sentinel permits Google fallback while explicit details win", async () => {
    await api.refreshEnrichment(env, { now, fetcher });
    const extra = {
        ...(await api.readEnrichments(db, [item], now + 5000)).get(
            api.stationKey(item),
        ),
        phone: "+61899811151",
        hours: { Monday: "09:00-17:00" },
        is24Hours: false,
        features: ["Toilets"],
    };
    const missing = api.normaliseStation(
        { ...item, phone: "--EMPTY--" },
        extra,
        now + 5000,
    );
    assert.equal(missing.phone, "+61899811151");
    assert.equal(missing.sourceNotes?.phone, undefined);
    const supplied = api.normaliseStation(
        {
            ...item,
            phone: "(08) 9222 3333",
            "site-features": "ATM Open Mon:06:00-20:00",
        },
        extra,
        now + 5000,
    );
    assert.equal(supplied.phone, "+61892223333");
    assert.equal(supplied.openHours.Monday, "06:00-20:00");
    assert.deepEqual(supplied.siteFeatures, ["ATM", "Toilets"]);
});

test("24-hour status reflects the merged schedule without overriding source hours", async () => {
    await api.refreshEnrichment(env, { now, fetcher });
    const extra = {
        ...(await api.readEnrichments(db, [item], now + 5000)).get(
            api.stationKey(item),
        ),
        hours: Object.fromEntries(
            api.WEEKDAYS.map((day) => [day, "06:00-20:00"]),
        ),
        is24Hours: false,
    };
    const limited = api.normaliseStation(
        { ...item, "site-features": "Open Mon:00:00-24:00" },
        extra,
        now + 5000,
    );
    assert.equal(limited.is24Hours, false);
    extra.hours = Object.fromEntries(
        api.WEEKDAYS.map((day) => [day, "00:00-24:00"]),
    );
    extra.is24Hours = true;
    const always = api.normaliseStation(
        { ...item, "site-features": "Open Mon:00:00-24:00" },
        extra,
        now + 5000,
    );
    assert.equal(always.is24Hours, true);
    assert.ok(always.siteFeatures.includes("Open 24 hours"));
    extra.hours = {};
    assert.equal(
        api.normaliseStation(
            { ...item, "site-features": "Open Mon:00:00-24:00" },
            extra,
            now + 5000,
        ).is24Hours,
        true,
    );
    const limitedSource = api.normaliseStation(
        { ...item, "site-features": "Open Mon:06:00-20:00" },
        extra,
        now + 5000,
    );
    assert.equal(limitedSource.is24Hours, false);
    assert.equal(limitedSource.openHours.Monday, "06:00-20:00");
    assert.equal(limitedSource.openHours.Tuesday, "00:00-24:00");
});

test("the exported scheduled entrypoint actually refreshes the bound database", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (url.hostname === "source.example") {
            const today = new Date(Date.now() + 8 * 3600_000)
                .toISOString()
                .slice(0, 10);
            return new Response(xml.replaceAll("2026-09-29", today));
        }
        return fetcher(url, init);
    };
    try {
        await api.handler.scheduled({}, env);
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.equal(googleCalls, 1);
    assert.equal(
        (
            await db
                .prepare(
                    "SELECT COUNT(*) AS count FROM station_enrichment WHERE enrichment_json IS NOT NULL",
                )
                .first()
        ).count,
        1,
    );
});

test("daily budget is atomic and prevents requests after exhaustion", async () => {
    // The configured maximum batch is valid, but cannot bypass a one-request daily cap.
    env.ENRICHMENT_BATCH_SIZE = "500";
    env.GOOGLE_DAILY_REQUEST_LIMIT = "1";
    await api.refreshEnrichment(env, { now, fetcher });
    await db.prepare("UPDATE station_enrichment SET next_attempt_at = 0").run();
    await api.refreshEnrichment(env, { now: now + 60_000, fetcher });
    assert.equal(googleCalls, 1);
    env.GOOGLE_DAILY_REQUEST_LIMIT = "0";
    await api.refreshEnrichment(env, { now, fetcher });
    assert.equal(googleCalls, 1);
    // Use a new accounting day for concurrent reservation testing.
    const reservations = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
            api.reserveGoogleRequest(db, now + 86400_000, 3),
        ),
    );
    assert.equal(
        reservations.filter((result) => result.status === "fulfilled").length,
        3,
    );
    assert.equal(
        (
            await db
                .prepare(
                    "SELECT requests FROM google_request_budget ORDER BY utc_day DESC LIMIT 1",
                )
                .first()
        ).requests,
        3,
    );
});

test("missing tables and corrupt cache records cannot fail fuel prices", async () => {
    await db
        .prepare(
            "INSERT INTO station_enrichment(station_key, seed_json, last_seen_at, enrichment_json) VALUES (?, '{}', ?, '{}')",
        )
        .bind(api.stationKey(item), now)
        .run();
    assert.equal((await api.readEnrichments(db, [item], now)).size, 0);
    await db.prepare("DROP TABLE station_enrichment").run();
    assert.equal((await api.readEnrichments(db, [item], now)).size, 0);
});

test("provider denial creates a global cooldown and retains existing data", async () => {
    await api.refreshEnrichment(env, { now, fetcher });
    await db.prepare("UPDATE station_enrichment SET next_attempt_at = 0").run();
    await api.refreshEnrichment(env, {
        now,
        fetcher: async (url) => {
            if (url.hostname === "source.example") return new Response(xml);
            googleCalls++;
            return new Response("denied", { status: 403 });
        },
    });
    await api.refreshEnrichment(env, { now: now + 15 * 60_000, fetcher });
    assert.equal(googleCalls, 2);
    assert.equal(
        (await api.readEnrichments(db, [item], now + 5000)).get(
            api.stationKey(item),
        ).postcode,
        "6000",
    );
    assert.ok(
        (
            await db
                .prepare("SELECT blocked_until FROM enrichment_refresh")
                .first()
        ).blocked_until > now,
    );
});

test("expiry refresh uses the stored place ID; stale enrichment has a hard age limit", async () => {
    await api.refreshEnrichment(env, { now, fetcher });
    await db.prepare("UPDATE station_enrichment SET next_attempt_at = 0").run();
    await api.refreshEnrichment(env, {
        now: now + 60_000,
        fetcher: async (url) => {
            if (url.hostname === "source.example") return new Response(xml);
            assert.equal(url.pathname, "/v1/places/test_place");
            googleCalls++;
            return Response.json(google);
        },
    });
    assert.equal(googleCalls, 2);
    const stale = (
        await api.readEnrichments(db, [item], now + 8 * 86400_000)
    ).get(api.stationKey(item));
    assert.equal(
        api.normaliseStation(item, stale, now + 8 * 86400_000).enrichment.stale,
        true,
    );
    assert.equal(
        (await api.readEnrichments(db, [item], now + 31 * 86400_000)).size,
        0,
    );
});

test("no-match results wait a day and malformed refreshes keep the last good enrichment", async () => {
    await api.refreshEnrichment(env, { now, fetcher });
    await db.prepare("UPDATE station_enrichment SET next_attempt_at = 0").run();
    await api.refreshEnrichment(env, {
        now: now + 60_000,
        fetcher: async (url) =>
            url.hostname === "source.example"
                ? new Response(xml)
                : Response.json([]),
    });
    assert.equal(
        (await api.readEnrichments(db, [item], now + 120_000)).size,
        1,
    );
    await db.prepare("UPDATE station_enrichment SET next_attempt_at = 0").run();
    await api.refreshEnrichment(env, {
        now: now + 120_000,
        fetcher: async (url) =>
            url.hostname === "source.example"
                ? new Response(xml)
                : Response.json({
                      ...google,
                      businessStatus: "CLOSED_PERMANENTLY",
                  }),
    });
    const row = await db.prepare("SELECT * FROM station_enrichment").first();
    assert.equal(row.enrichment_json, null);
    assert.ok(row.next_attempt_at >= now + 86400_000);
});

test("slow D1 reads are bounded and stop subsequent batches", async () => {
    let calls = 0;
    const stalledDb = {
        prepare: () => ({
            bind: () => ({
                all: () => {
                    calls++;
                    return new Promise(() => {});
                },
            }),
        }),
    };
    const stations = Array.from({ length: 100 }, (_, i) => ({
        ...item,
        address: `${i} Road`,
    }));
    const started = Date.now();
    assert.equal((await api.readEnrichments(stalledDb, stations, now)).size, 0);
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 3000);
});

test("refresh summaries distinguish saved matches from unmatched stations and pending backlog", async (context) => {
    const log = context.mock.method(console, "log", () => {});
    await api.refreshEnrichment(env, { now, fetcher });
    let summary = log.mock.calls.at(-1).arguments[0];
    assert.equal(summary.matched, 1);
    assert.equal(summary.unmatched, 0);
    assert.equal(summary.requestsReserved, 1);
    assert.deepEqual(summary.cache, { stations: 1, enriched: 1, pending: 0 });
    await db
        .prepare(
            "UPDATE station_enrichment SET next_attempt_at = 0, place_id = NULL, enrichment_json = NULL",
        )
        .run();
    await api.refreshEnrichment(env, {
        now: now + 60_000,
        fetcher: async (url) =>
            url.hostname === "source.example"
                ? new Response(xml)
                : Response.json({}),
    });
    summary = log.mock.calls.at(-1).arguments[0];
    assert.equal(summary.matched, 0);
    assert.equal(summary.unmatched, 1);
    assert.equal(summary.requestsReserved, 2);
    assert.equal(summary.failed, 0);
    assert.deepEqual(summary.cache, { stations: 1, enriched: 0, pending: 0 });
});

test("losing the lease cannot be logged as a saved enrichment", async (context) => {
    const log = context.mock.method(console, "log", () => {});
    await api.refreshEnrichment(env, {
        now,
        fetcher: async (url) => {
            if (url.hostname === "source.example") return new Response(xml);
            await db
                .prepare(
                    "UPDATE enrichment_refresh SET owner = 'successor' WHERE id = 1",
                )
                .run();
            return Response.json({ places: [google] });
        },
    });
    const summary = log.mock.calls.at(-1).arguments[0];
    assert.equal(summary.matched, 0);
    assert.equal(summary.writeSkipped, 1);
    assert.equal(summary.stopReason, "lease_lost");
    assert.equal(
        (
            await db
                .prepare("SELECT enrichment_json FROM station_enrichment")
                .first()
        ).enrichment_json,
        null,
    );
});
