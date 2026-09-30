import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare, NoOpLog } from "miniflare";

const output = fileURLToPath(
    new URL("../dist/test/snapshot-cache.cjs", import.meta.url),
);
await build({
    stdin: {
        contents:
            'export * from "./src/snapshot-cache"; export * from "./src/query"; export * from "./src/warm"; export * from "./src/catalogue";',
        resolveDir: fileURLToPath(new URL("..", import.meta.url)),
        loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: output,
    logLevel: "silent",
});
const api = createRequire(import.meta.url)(output);
const migration = await readFile(
    new URL("../migrations/0002_feed_cache.sql", import.meta.url),
    "utf8",
);
const source = "https://source.example/rss";
const start = Date.parse("2026-09-29T12:00:00+08:00");
const item = (day = "2026-09-29", description = "Station", number = 1) =>
    `<item><description>${description}</description><brand>Example</brand><date>${day}</date><price>185.9</price><trading-name>Example Station</trading-name><location>PERTH</location><address>${number} Test Road</address><latitude>-31.95</latitude><longitude>115.86</longitude></item>`;
const xml = (items = item()) =>
    `<rss version="2.0"><channel><title>FuelWatch</title>${items}</channel></rss>`;
let worker, db, now, calls, origin;
const query = (params = "", at = now) =>
    api.parseQuery(new URLSearchParams(params), at);
const options = () => ({
    clock: () => now,
    fetcher: async (url) => {
        calls++;
        return origin(url);
    },
});
const load = (params = "", extra = {}) =>
    api.loadCachedSnapshot(db, source, query(params), {
        ...options(),
        ...extra,
    });

beforeEach(async () => {
    now = start;
    calls = 0;
    origin = () => new Response(xml());
    worker = new Miniflare(
        convertV4MiniflareOptions({
            modules: true,
            script: 'export default { fetch() { return new Response("ok") } }',
            compatibilityDate: "2026-09-29",
            cf: false,
            log: new NoOpLog(),
            d1Databases: { FUELWATCH_DB: "snapshot-cache" },
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
});
afterEach(async () => {
    await worker.dispose();
});

test("hourly refresh replaces a fresh snapshot once per scheduled hour without blocking readers", async () => {
    const first = await load();
    now += 3600_000;
    const refreshBefore = now;
    origin = async () => {
        const reader = await load();
        assert.equal(reader.cacheStatus, "HIT");
        assert.equal(reader.fetchedAt, first.fetchedAt);
        return new Response(xml().replace("185.9", "199.9"));
    };
    const refreshed = await load("", { refreshBefore });
    assert.equal(refreshed.cacheStatus, "MISS");
    assert.equal(refreshed.feed.items[0].price, "199.9");
    assert.equal(calls, 2);
    assert.equal((await load("", { refreshBefore })).cacheStatus, "HIT");
    assert.equal(calls, 2);
});

test("failed or unexpectedly empty hourly refreshes retain the published snapshot", async () => {
    const first = await load();
    now += 3600_000;
    for (const body of [xml().replace("185.9", "bad"), xml("")]) {
        origin = () => new Response(body);
        await assert.rejects(load("", { refreshBefore: now }), {
            code: "invalid_feed",
        });
        const retained = await load();
        assert.equal(retained.fetchedAt, first.fetchedAt);
        assert.deepEqual(retained.feed, first.feed);
    }
});

test("hourly warming covers all fuels, respects AWST periods and bounds concurrency", async () => {
    for (const [at, days] of [
        ["2026-09-29T05:00:00+08:00", ["yesterday", "today"]],
        ["2026-09-29T06:00:00+08:00", ["today"]],
        ["2026-09-29T14:00:00+08:00", ["today"]],
        ["2026-09-29T15:00:00+08:00", ["today", "tomorrow"]],
    ]) {
        now = Date.parse(at);
        let active = 0;
        let maximum = 0;
        const fetched = [];
        const env = { FUELWATCH_DB: db, FUELWATCH_URL: source };
        const fetcher = async (url) => {
            maximum = Math.max(maximum, ++active);
            fetched.push(
                `${url.searchParams.get("Product")}/${url.searchParams.get("Day")}`,
            );
            await new Promise((resolve) => setTimeout(resolve, 10));
            active--;
            const date = {
                yesterday: "2026-09-28",
                today: "2026-09-29",
                tomorrow: "2026-09-30",
            }[url.searchParams.get("Day")];
            return new Response(xml(item(date)));
        };
        await api.warmSnapshots(env, now, { clock: () => now, fetcher });
        assert.equal(fetched.length, days.length * 7);
        assert.ok(maximum <= 3);
        for (const day of days)
            for (const fuel of [1, 2, 4, 5, 6, 10, 11])
                assert.ok(fetched.includes(`${fuel}/${day}`));
        await api.warmSnapshots(env, now, { clock: () => now, fetcher });
        assert.equal(fetched.length, days.length * 7);
    }
});

test("hourly warming continues healthy products, reports failures and remains usable without Google", async () => {
    const fetched = [];
    await assert.rejects(
        api.warmSnapshots({ FUELWATCH_DB: db, FUELWATCH_URL: source }, now, {
            clock: () => now,
            fetcher: async (url) => {
                fetched.push(url.searchParams.get("Product"));
                return new Response(
                    xml().replace(
                        "185.9",
                        url.searchParams.get("Product") === "2"
                            ? "bad"
                            : "185.9",
                    ),
                );
            },
        }),
        /failed for 1 selections/,
    );
    assert.equal(fetched.length, 7);
    assert.equal((await load("product=4")).cacheStatus, "HIT");
    assert.equal(calls, 0);
});

test("shared snapshots expire six hours after fetching, never six hours after reading", async () => {
    const first = await load("brand=2,35&product=1,2");
    assert.equal(first.cacheStatus, "MISS");
    assert.equal(first.expiresAt, start + 6 * 3600_000);
    assert.equal(calls, 4);
    now += 6 * 3600_000 - 1;
    const hit = await load("FILTER[PRODUCT]=2,1&BRAND=35,2");
    assert.equal(hit.cacheStatus, "HIT");
    assert.equal(hit.fetchedAt, start);
    assert.equal(hit.expiresAt, first.expiresAt);
    assert.deepEqual(hit.feed, first.feed);
    assert.equal(calls, 4);
    now++;
    assert.equal((await load("brand=2,35&product=1,2")).cacheStatus, "MISS");
    assert.equal(calls, 8);
});

test("simultaneous misses share one origin fetch and one durable snapshot", async () => {
    origin = async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return new Response(xml());
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => load()));
    assert.equal(calls, 1);
    assert.equal(
        results.filter((result) => result.cacheStatus === "MISS").length,
        1,
    );
    assert.equal(
        results.filter((result) => result.cacheStatus === "HIT").length,
        9,
    );
    for (const result of results)
        assert.deepEqual(result.feed, results[0].feed);
});

test("unpublished, empty and partially published product selections are retried quickly", async () => {
    origin = () => new Response(xml(""));
    const empty = await load("day=tomorrow");
    assert.equal(empty.expiresAt, now + 30_000);
    now += 30_000;
    origin = () => new Response(xml(item("2026-09-30")));
    assert.equal((await load("day=tomorrow")).feed.items.length, 1);
    origin = (url) =>
        new Response(
            xml(url.searchParams.get("Product") === "2" ? "" : item()),
        );
    const partial = await load("product=1,2");
    assert.equal(partial.expiresAt, now + 30_000);
    now += 30_000;
    origin = () => new Response(xml());
    assert.equal((await load("product=1,2")).feed.items.length, 2);
});

test("absolute dates share tomorrow/today snapshots across midnight without reusing a different day's feed", async () => {
    now = Date.parse("2026-09-29T23:00:00+08:00");
    origin = () => new Response(xml(item("2026-09-30")));
    const tomorrow = await load("day=tomorrow");
    now += 2 * 3600_000;
    const today = await load("day=TODAY");
    assert.equal(today.cacheStatus, "HIT");
    assert.equal(today.fetchedAt, tomorrow.fetchedAt);
    assert.equal(calls, 1);
    origin = () => new Response(xml(item("2026-10-01")));
    assert.equal((await load("day=tomorrow")).cacheStatus, "MISS");
    assert.equal(calls, 2);
});

test("origin errors release the lease, never store partial data, and allow a successful retry", async () => {
    origin = () => new Response(xml().replace("185.9", "bad"));
    await assert.rejects(load(), { code: "invalid_feed" });
    assert.equal(
        (await db.prepare("SELECT owner FROM feed_cache").first()).owner,
        null,
    );
    assert.equal(
        (
            await db
                .prepare("SELECT COUNT(*) AS n FROM feed_cache_chunks")
                .first()
        ).n,
        0,
    );
    origin = () => new Response(xml());
    assert.equal((await load()).cacheStatus, "MISS");
    assert.equal(calls, 2);
});

test("an active lease returns a bounded retry response; an abandoned lease can be reclaimed", async () => {
    await load();
    await db
        .prepare(
            "UPDATE feed_cache SET expires_at = 0, owner = 'other', lease_until = ?",
        )
        .bind(now + 60_000)
        .run();
    await assert.rejects(load("", { waitMs: 0 }), {
        status: 503,
        code: "cache_refresh_busy",
        retryAfter: 2,
    });
    assert.equal(calls, 1);
    now += 60_000;
    assert.equal((await load()).cacheStatus, "MISS");
    assert.equal(calls, 2);
});

test("an expired owner cannot overwrite a replacement snapshot", async () => {
    origin = async () => {
        await db
            .prepare(
                "UPDATE feed_cache SET owner = 'new-owner', lease_until = ?",
            )
            .bind(now + 60_000)
            .run();
        return new Response(xml());
    };
    await assert.rejects(load(), { code: "cache_refresh_busy" });
    assert.equal(
        (await db.prepare("SELECT owner FROM feed_cache").first()).owner,
        "new-owner",
    );
    assert.equal(
        (
            await db
                .prepare("SELECT COUNT(*) AS n FROM feed_cache_chunks")
                .first()
        ).n,
        0,
    );
});

test("storage failures serve the validated feed once and report bypass instead of refetching", async () => {
    await db.exec("DROP TABLE feed_cache_chunks");
    assert.equal((await load()).cacheStatus, "BYPASS");
    assert.equal(calls, 1);
});

test("failed publication preserves the valid response and releases its cache lease", async () => {
    origin = async () => {
        await db.exec(
            "CREATE TRIGGER fail_write BEFORE INSERT ON feed_cache_chunks BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;",
        );
        return new Response(xml());
    };
    assert.equal((await load()).cacheStatus, "BYPASS");
    assert.equal(calls, 1);
    assert.equal(
        (await db.prepare("SELECT owner FROM feed_cache").first()).owner,
        null,
    );
});

test("large snapshots round-trip through multiple compressed chunks below D1 row limits", async () => {
    const large = xml(
        Array.from({ length: 200 }, (_, i) =>
            item("2026-09-29", randomBytes(7000).toString("base64"), i),
        ).join(""),
    );
    origin = () => new Response(large);
    const first = await load();
    const chunks = await db
        .prepare("SELECT length(payload) AS bytes FROM feed_cache_chunks")
        .all();
    assert.ok(chunks.results.length >= 2);
    assert.ok(chunks.results.every((row) => row.bytes <= 1_000_000));
    assert.deepEqual((await load()).feed, first.feed);
    assert.equal(calls, 1);
});

test("corrupt snapshots are replaced and cleanup removes expired chunks without removing active leases", async () => {
    await load();
    await db.exec("UPDATE feed_cache_chunks SET payload = x'000102'");
    assert.equal((await load()).cacheStatus, "MISS");
    assert.equal(calls, 2);
    await db.exec("DELETE FROM feed_cache_chunks");
    assert.equal((await load()).cacheStatus, "MISS");
    assert.equal(calls, 3);
    await load("product=2");
    now += 6 * 3600_000;
    await db
        .prepare(
            "UPDATE feed_cache SET owner = 'active', lease_until = ? WHERE cache_key = (SELECT cache_key FROM feed_cache LIMIT 1)",
        )
        .bind(now + 60_000)
        .run();
    await api.pruneSnapshots(db, now);
    assert.equal(
        (await db.prepare("SELECT COUNT(*) AS n FROM feed_cache").first()).n,
        1,
    );
    assert.equal(
        (
            await db
                .prepare("SELECT COUNT(*) AS n FROM feed_cache_chunks")
                .first()
        ).n,
        1,
    );
});

test("hourly extracts serve all products and changed exact filters without origin requests", async () => {
    await api.warmSnapshots(
        { FUELWATCH_DB: db, FUELWATCH_URL: source },
        now,
        options(),
    );
    assert.equal(calls, 7);
    const read = (filters) =>
        api.loadCatalogue(
            db,
            source,
            api.parseQuery(new URLSearchParams(filters), now, "catalogue"),
            options(),
        );
    for (const filters of [
        "",
        "product=2,6",
        "suburb=PERTH&surrounding=no",
        "brand=5",
    ])
        assert.equal((await read(filters)).cacheStatus, "HIT");
    assert.equal(calls, 7);
    assert.equal((await read("")).feed.items.length, 7);
    assert.equal(
        (await read("suburb=fremantle&surrounding=no")).feed.items.length,
        0,
    );
});

test("catalogue keeps original provenance and retries only the missing product", async () => {
    const read = () =>
        api.loadCatalogue(
            db,
            source,
            api.parseQuery(
                new URLSearchParams("product=1,2"),
                now,
                "catalogue",
            ),
            options(),
        );
    origin = (url) =>
        new Response(
            xml(url.searchParams.get("Product") === "2" ? "" : item()),
        );
    const first = await read();
    assert.equal(first.expiresAt, now + 30_000);
    assert.equal(calls, 2);
    now += 30_000;
    origin = () => new Response(xml());
    const complete = await read();
    assert.equal(complete.feed.items.length, 2);
    assert.equal(complete.fetchedAt, first.fetchedAt);
    assert.equal(complete.upstreamRequests, 1);
    assert.equal(calls, 3);
});

test("catalogue aborts hanging origin work and never returns a partial result", async () => {
    const selection = api.parseQuery(
        new URLSearchParams("product=1,2"),
        now,
        "catalogue",
    );
    await assert.rejects(
        api.loadCatalogue(undefined, source, selection, {
            timeoutMs: 30,
            fetcher: (_url, init) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener(
                        "abort",
                        () => reject(new DOMException("Aborted", "AbortError")),
                        { once: true },
                    );
                }),
        }),
        { code: "upstream_timeout" },
    );
});
