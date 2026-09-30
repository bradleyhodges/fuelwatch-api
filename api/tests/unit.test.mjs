import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const output = fileURLToPath(
    new URL("../dist/test/units.cjs", import.meta.url),
);
await build({
    stdin: {
        contents:
            'export * from "./src/cache"; export * from "./src/query"; export * from "./src/feed"; export * from "./src/upstream"; export * from "./src/fuelwatch"; export * from "./src/snapshot"; export * from "./src/jsonapi"; export * from "./src/references"; export * from "./src/station";',
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
const time = (value) => Date.parse(value);
const query = (value, now = "2026-09-29T16:00:00+08:00") =>
    api.parseQuery(new URLSearchParams(value), time(now));
const source = new URL("https://source.example/rss");

test("reference registry covers controlled vocabularies with unique permanent IDs", () => {
    const { brands, siteFeatures, restrictions } = api.REFERENCES;
    assert.deepEqual(
        Object.fromEntries(
            brands
                .filter((value) => value.code)
                .map((value) => [value.code, value.name]),
        ),
        api.brands,
    );
    assert.equal(brands.find((value) => value.name === "BP").code, 5);
    assert.equal(
        siteFeatures.find((value) => value.name === "Credit Cards").code,
        1,
    );
    for (const values of [brands, siteFeatures, restrictions]) {
        assert.equal(
            new Set(values.map((value) => value.code)).size,
            values.length,
        );
        assert.equal(
            new Set(values.map((value) => value.name)).size,
            values.length,
        );
        assert.ok(
            values.every(
                (value) => Number.isInteger(value.code) && value.code >= 0,
            ),
        );
    }
    // The parser's controlled labels must never reach serialization without a code assignment.
    assert.deepEqual(
        siteFeatures.map((item) => item.name).sort(),
        [...api.FEATURES].sort(),
    );
    assert.deepEqual(
        restrictions.map((item) => item.name).sort(),
        [...api.RESTRICTIONS].sort(),
    );
});

test("expansion canonicalizes equivalent sets only in rendered cache keys", () => {
    const first = api.parseExpansion(
        new URLSearchParams("product=1&expand=ALL"),
    );
    const second = api.parseExpansion(
        new URLSearchParams(
            "product=1&EXPAND=RESTRICTIONS,brand,siteFEATURES,brand",
        ),
    );
    assert.deepEqual(first.expand, second.expand);
    const compact = query("product=1");
    assert.equal(first.filters.toString(), "product=1");
    const url = new URL("https://worker.example/v1");
    assert.equal(
        api.cacheKey(url, compact, first.expand).url,
        api.cacheKey(url, compact, second.expand).url,
    );
    assert.notEqual(
        api.cacheKey(url, compact, first.expand).url,
        api.cacheKey(url, compact).url,
    );
    assert.equal(compact.canonical.has("Expand"), false);
});

test("response freshness stops at provider refresh and hard age boundaries", () => {
    const now = time("2026-09-29T08:00:00Z");
    const profile = {
        fetchedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
    };
    assert.equal(api.enrichmentTtl([profile], now), 60);
    assert.equal(
        api.enrichmentTtl(
            [
                {
                    ...profile,
                    fetchedAt: new Date(
                        now - 30 * 86400_000 + 900,
                    ).toISOString(),
                },
            ],
            now,
        ),
        0,
    );
    assert.equal(
        api.enrichmentTtl(
            [{ ...profile, expiresAt: new Date(now - 1000).toISOString() }],
            now,
        ),
        30 * 86400 - 1,
    );
    assert.equal(api.enrichmentTtl([], now), Infinity);
});

const rawStation = JSON.parse(
    await readFile(
        new URL("./fixtures/fuelwatch-rss-item.json", import.meta.url),
        "utf8",
    ),
);
const station = (overrides = {}) =>
    api.compactFeed({
        title: "FuelWatch",
        items: [{ ...rawStation, ...overrides }],
    }).items[0];

test("station JSON has structured cents-per-litre price, Perth source date and numeric coordinates", () => {
    const result = station();
    assert.equal(result.name, "Billabong Roadhouse");
    assert.equal(result.tradingName, result.name);
    assert.deepEqual(result.price, {
        perLitre: 195,
        asAt: "2026-09-29T06:00:00.000+08:00",
    });
    assert.deepEqual(result.address, {
        street: "Lot 2 North West Coastal Hwy",
        suburb: "MEADOW",
        state: "WA",
        postcode: null,
    });
    assert.equal(result.latitude, -26.816033);
    assert.equal(result.longitude, 114.614261);
    assert.equal(result.description, undefined);
    assert.equal(result.is24Hours, false);
    assert.equal(result.openHours.Monday, "06:00-20:30");
});

test("features and restrictions use closed canonical vocabularies and keep unknown notes", () => {
    const result = station({
        "site-features":
            "Fuel Cards ATM Toilets Bottled Gas EFTPOS ATM Water Ice Discount Voucher Mystery facility, Open 24 hours",
        restrictions:
            "Unmanned site (credit card charges may apply); Membership Required; Unknown condition;",
    });
    assert.deepEqual(result.siteFeatures, [
        "Fuel Cards",
        "ATM",
        "Toilets",
        "Bottled Gas",
        "EFTPOS",
        "Water",
        "Ice",
        "Discount",
        "Voucher",
        "Open 24 hours",
    ]);
    assert.deepEqual(result.restrictions, [
        "Unmanned site (credit card charges may apply)",
        "Membership Required",
    ]);
    assert.deepEqual(result.sourceNotes.features, ["Mystery facility"]);
    assert.deepEqual(result.sourceNotes.restrictions, ["Unknown condition"]);
    assert.equal(result.is24Hours, true);
    assert.equal(result.openHours, undefined);
});

test("opening hours expand day ranges and preserve closed days and overnight shifts", () => {
    const result = station({
        "site-features": "Open Mon-Fri: 06:00-20:30, Sat: 20:00-02:00, Sun: -",
    });
    assert.deepEqual(result.openHours, {
        Monday: "06:00-20:30",
        Tuesday: "06:00-20:30",
        Wednesday: "06:00-20:30",
        Thursday: "06:00-20:30",
        Friday: "06:00-20:30",
        Saturday: "20:00-02:00",
        Sunday: "Closed",
    });
    assert.equal(result.is24Hours, false);
});

test("absent or unparseable hours are unknown and retain source text", () => {
    const missing = station({ "site-features": "", restrictions: "" });
    assert.equal(missing.is24Hours, null);
    assert.equal(missing.openHours, undefined);
    assert.deepEqual(missing.siteFeatures, []);
    assert.equal(missing.restrictions, null);
    const invalid = station({ "site-features": "Open Mon: 99:00-20:00" });
    assert.equal(invalid.openHours, undefined);
    assert.equal(invalid.is24Hours, null);
    assert.equal(invalid.sourceNotes.openHours, "Open Mon: 99:00-20:00");
});

test("phone numbers are valid E.164 or null, with invalid source values retained separately", () => {
    assert.equal(station({ phone: "(08) 9981 1151" }).phone, "+61899811151");
    assert.equal(station({ phone: "+61899811151" }).phone, "+61899811151");
    for (const phone of [
        null,
        "",
        "123",
        "call 08 9981 1151 or 04 1234 5678",
    ]) {
        assert.equal(station({ phone }).phone, null);
    }
    assert.equal(station({ phone: "123" }).sourceNotes.phone, "123");
});

test("worker output matches the Home Assistant contract fixture", async () => {
    const expected = JSON.parse(
        await readFile(
            new URL("./fixtures/fuelwatch-v1.json", import.meta.url),
            "utf8",
        ),
    );
    const fields = Object.entries({
        title: "Example",
        description: "Station description",
        brand: "BP",
        date: expected.meta.sourceDate,
        price: "185.9",
        "trading-name": "Example Station",
        address: "1 Test Road",
        location: "PERTH",
        latitude: "-31.95",
        longitude: "115.86",
    })
        .map(([key, value]) => `<${key}>${value}</${key}>`)
        .join("");
    const feed = await api.parseFeed(
        `<rss version="2.0"><channel><title>FuelWatch</title><item>${fields}</item></channel></rss>`,
        expected.meta.sourceDate,
    );
    const now = time(expected.meta.fetchedAt);
    const document = await api.jsonApiDocument(
        {
            ...feed,
            items: feed.items.map((item) => ({ ...item, product: 1 })),
        },
        api.metadata(query(""), feed.items.length, now),
        undefined,
        now,
    );
    // JSON:API meta is extensible; verify every consumer-required field while
    // allowing informational additions such as copyright and documentation links.
    assert.deepEqual(
        {
            ...document,
            meta: Object.fromEntries(
                Object.keys(expected.meta).map((key) => [
                    key,
                    document.meta[key],
                ]),
            ),
        },
        expected,
    );
});

test("Perth calendar transitions include leap days and year boundaries", () => {
    assert.equal(
        query("Day=yesterday", "2026-01-01T00:00:00+08:00").sourceDate,
        "2025-12-31",
    );
    assert.equal(
        query("Day=tomorrow", "2028-02-28T23:59:59+08:00").sourceDate,
        "2028-02-29",
    );
    assert.equal(
        query("Day=28/09/2026", "2026-09-29T05:59:59+08:00").upstream[0].get(
            "Day",
        ),
        "yesterday",
    );
    assert.throws(() => query("Day=31/09/2026"), { code: "invalid_query" });
});

test("canonical keys normalize defaults, suburb whitespace and date aliases", () => {
    const first = query("Suburb=Perth&Day=today");
    const second = query("Product=1&Day=29/09/2026&Suburb=%20PERTH%20");
    const url = new URL("https://worker.example/v1");
    assert.equal(api.cacheKey(url, first).url, api.cacheKey(url, second).url);
    assert.notEqual(
        api.cacheKey(url, first).url,
        api.cacheKey(new URL("https://worker.example/legacy"), first).url,
    );
});

test("query names and text values ignore case and surrounding whitespace", () => {
    const result = query(
        "pRoDuCt=4&dAy=ToDaY&sUbUrB=%20South%20%20Perth%20&SuRrOuNdInG=YeS&bRaNd=2",
    );
    assert.deepEqual(result.products, [4]);
    assert.deepEqual(Object.fromEntries(result.upstream[0]), {
        Brand: "2",
        Day: "today",
        Product: "4",
        Suburb: "SOUTH PERTH",
        Surrounding: "yes",
    });
});

test("JSON API filter families and shorthand aliases share validation and cache identity", () => {
    assert.equal(
        query(
            "filter[brand]=2,35&FILTER[Product]=1,2,6&filter[day]=TODAY",
        ).canonical.toString(),
        query("brand=35,2&product=6,2,1&day=today").canonical.toString(),
    );
    for (const value of [
        "product=1&filter[product]=2",
        "filter[Product]=1&FILTER[product]=2",
        "filter[unknown]=1",
        "filter[product][invalid]=1",
    ]) {
        assert.throws(() => query(value), { code: "invalid_query" });
    }
});

test("list filters expand every combination once and canonicalize equivalent requests", () => {
    const first = query(
        "brand=35,2,2&PRODUCT=6,2,1&Suburb=Perth,FREMANTLE,perth&day=TODAY",
    );
    const second = query(
        "DAY=29/09/2026&product=1,2,6&brand=2,35&suburb=Fremantle,Perth",
    );
    assert.deepEqual(first.products, [1, 2, 6]);
    assert.equal(first.upstream.length, 12);
    assert.equal(new Set(first.upstream.map(String)).size, 12);
    assert.equal(first.canonical.toString(), second.canonical.toString());
    assert.deepEqual(
        [...new Set(first.upstream.map((p) => p.get("Brand")))],
        ["2", "35"],
    );
    assert.deepEqual(
        [...new Set(first.upstream.map((p) => p.get("Suburb")))],
        ["FREMANTLE", "PERTH"],
    );
    assert.ok(
        first.upstream.every((p) =>
            [...p.values()].every((v) => !v.includes(",")),
        ),
    );
    assert.equal(
        query("product=1,1").canonical.toString(),
        query("product=1").canonical.toString(),
    );
    assert.equal(query("region=26,25&product=1,2").upstream.length, 4);
});

test("ambiguous keys, malformed lists and excessive filter combinations fail validation", () => {
    for (const value of [
        "Product=1&product=4",
        "DAY=today&Day=TODAY",
        "brand=2,",
        "product=1,,2",
        "product=1,999",
        "region=25,999",
        "suburb=perth,%20",
        "suburb=perth,%0Atest",
        "day=today,tomorrow",
        "surrounding=yes,no",
        "brand=2,35,5,6&product=1,2,4,5,6,10,11",
    ])
        assert.throws(() => query(value), { code: "invalid_query" }, value);
});

for (const [now, day, count, expected] of [
    ["2026-09-29T16:00:00+08:00", "today", 1, 21600],
    ["2026-09-29T13:00:00+08:00", "today", 1, 21600],
    ["2026-09-29T05:00:00+08:00", "today", 1, 21600],
    ["2026-09-29T16:00:00+08:00", "today", 0, 30],
    ["2026-09-29T23:59:45+08:00", "today", 1, 15],
    ["2026-09-29T05:59:45+08:00", "yesterday", 1, 15],
    ["2026-09-29T06:00:00+08:00", "yesterday", 1, 0],
    ["2026-09-29T14:29:45+08:00", "tomorrow", 0, 15],
])
    test(`freshness at ${now}, ${day}, count ${count}`, () => {
        const info = api.metadata(query(`Day=${day}`, now), count, time(now));
        assert.equal(api.cacheTtl(info, time(now)), expected);
    });

test("provenance distinguishes unpublished future prices from empty results", () => {
    const now = "2026-09-29T10:00:00+08:00";
    const info = api.metadata(query("Day=tomorrow", now), 0, time(now));
    assert.equal(info.publicationStatus, "not_yet_published");
    assert.equal(info.validFrom, "2026-09-30T06:00:00.000+08:00");
    assert.equal(info.validUntil, "2026-10-01T06:00:00.000+08:00");
});

test("all snapshot timestamps render in AWST across the UTC year boundary", () => {
    const now = time("2026-12-31T18:00:00Z");
    const info = api.metadata(
        api.parseQuery(new URLSearchParams(), now),
        1,
        now,
    );
    assert.equal(info.sourceDate, "2027-01-01");
    assert.equal(info.fetchedAt, "2027-01-01T02:00:00.000+08:00");
    assert.equal(info.validFrom, "2027-01-01T06:00:00.000+08:00");
    assert.equal(info.validUntil, "2027-01-02T06:00:00.000+08:00");
});

test("cache failures do not escape into the request handler", async () => {
    const key = new Request("https://worker.example/cache");
    const cache = {
        match: async () => {
            throw new Error("unavailable");
        },
        put: async () => {
            throw new Error("unavailable");
        },
    };
    assert.equal(await api.readCache(cache, key, Date.now()), undefined);
    await assert.doesNotReject(
        api.writeCache(cache, key, new Response("valid")),
    );
});

test("expired or malformed cache records are never served", async () => {
    for (const expiry of ["invalid", "1", ""]) {
        const cache = {
            match: async () =>
                new Response("stale", {
                    headers: { "X-FuelWatch-Fresh-Until": expiry },
                }),
        };
        assert.equal(
            await api.readCache(
                cache,
                new Request("https://worker.example"),
                Date.now(),
            ),
            undefined,
        );
    }
});

test("cache records expiring during lookup are treated as misses", async () => {
    const started = Date.now();
    const cache = {
        match: async () => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            return new Response("stale", {
                headers: { "X-FuelWatch-Fresh-Until": String(started + 10) },
            });
        },
    };
    assert.equal(
        await api.readCache(
            cache,
            new Request("https://worker.example"),
            started,
        ),
        undefined,
    );
});

for (const [status, oversized, expected] of [
    [503, false, "upstream_timeout"],
    [200, true, "response_too_large"],
]) {
    test(`cleanup cannot stall the deadline for status ${status}`, async () => {
        const fetcher = async () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        if (oversized)
                            controller.enqueue(
                                new Uint8Array(api.MAX_RESPONSE_BYTES + 1),
                            );
                    },
                    cancel() {
                        return new Promise(() => {});
                    },
                }),
                { status },
            );
        let timer;
        try {
            await assert.rejects(
                Promise.race([
                    api.fetchFeed(source, { fetcher, timeoutMs: 20 }),
                    new Promise((_, reject) => {
                        timer = setTimeout(
                            () => reject(new Error("Cleanup stalled")),
                            150,
                        );
                    }),
                ]),
                { code: expected },
            );
        } finally {
            clearTimeout(timer);
        }
    });
}

test("XML validation rejects extra roots, trailing text and duplicate singleton fields", async () => {
    const xml =
        '<rss version="2.0"><channel><title>FuelWatch</title><item><price>185.9</price><date>2026-09-29</date><trading-name>Station</trading-name><address>1 Road</address><location>PERTH</location><latitude>-31.95</latitude><longitude>115.86</longitude></item></channel></rss>';
    for (const body of [
        `${xml}<junk/>`,
        `${xml}not xml`,
        xml.replace("</price>", "</price><price>NaN</price>"),
    ]) {
        await assert.rejects(api.parseFeed(body, "2026-09-29"), {
            code: "invalid_feed",
        });
    }
});

test("timeout aborts a stalled origin before response headers", async () => {
    let aborted = false;
    const fetcher = (_url, { signal }) =>
        new Promise((_resolve, reject) =>
            signal.addEventListener(
                "abort",
                () => {
                    aborted = true;
                    reject(signal.reason);
                },
                { once: true },
            ),
        );
    await assert.rejects(api.fetchFeed(source, { fetcher, timeoutMs: 20 }), {
        code: "upstream_timeout",
        status: 504,
    });
    assert.equal(aborted, true);
});

test("timeout aborts a stalled body and cancels its reader", async () => {
    let cancelled = false;
    const fetcher = async () =>
        new Response(
            new ReadableStream({
                cancel() {
                    cancelled = true;
                },
            }),
        );
    await assert.rejects(api.fetchFeed(source, { fetcher, timeoutMs: 20 }), {
        code: "upstream_timeout",
    });
    assert.equal(cancelled, true);
});

test("retry sleep uses the same overall request deadline", async () => {
    let attempts = 0;
    const fetcher = async () => {
        attempts++;
        return new Response("busy", { status: 503 });
    };
    await assert.rejects(api.fetchFeed(source, { fetcher, timeoutMs: 20 }), {
        code: "upstream_timeout",
    });
    assert.equal(attempts, 1);
});

test("malformed UTF-8 is a validation failure and is not retried", async () => {
    let attempts = 0;
    const fetcher = async () => {
        attempts++;
        return new Response(new Uint8Array([0xc3, 0x28]));
    };
    await assert.rejects(api.fetchFeed(source, { fetcher }), {
        code: "invalid_feed",
        status: 502,
    });
    assert.equal(attempts, 1);
});

test("HTTP-date Retry-After values are interpreted as seconds", () => {
    assert.equal(
        api.retryAfterSeconds(
            "Tue, 29 Sep 2026 08:01:00 GMT",
            time("2026-09-29T08:00:00Z"),
        ),
        60,
    );
    assert.equal(api.retryAfterSeconds("invalid", Date.now()), undefined);
});

test("station count and conflicting identities are bounded atomically", async () => {
    const item =
        "<item><price>185.9</price><date>2026-09-29</date><trading-name>Station</trading-name><address>1 Road</address><location>PERTH</location><latitude>-31.95</latitude><longitude>115.86</longitude></item>";
    const feed = (items) =>
        `<rss version="2.0"><channel><title>FuelWatch</title>${items}</channel></rss>`;
    await assert.rejects(api.parseFeed(feed(item.repeat(5001)), "2026-09-29"), {
        code: "invalid_feed",
    });
    await assert.rejects(
        api.parseFeed(
            feed(item + item.replace("185.9", "199.9")),
            "2026-09-29",
        ),
        { code: "invalid_feed" },
    );
    assert.equal(
        (await api.parseFeed(feed(item + item), "2026-09-29")).items.length,
        1,
    );
    assert.equal(
        (
            await api.parseFeed(
                feed(
                    item +
                        item
                            .replace("115.86", "115.87")
                            .replace("185.9", "199.9"),
                ),
                "2026-09-29",
            )
        ).items.length,
        2,
    );
});

test("catalogue defaults to every fuel and bounds source-filter expansion only", () => {
    const all = api.parseQuery(
        new URLSearchParams("brand=2,5,35,15"),
        time("2026-09-29T16:00:00+08:00"),
        "catalogue",
    );
    assert.deepEqual(all.products, [1, 2, 4, 5, 6, 10, 11]);
    assert.equal(all.upstream.length, 7);
    assert.equal(all.catalogue, true);
    for (const [filters, expected] of [
        ["suburb=perth", false],
        ["suburb=perth&surrounding=yes", false],
        ["suburb=perth&surrounding=no", true],
        ["region=25", false],
    ]) {
        assert.equal(
            api.parseQuery(
                new URLSearchParams(filters),
                Date.now(),
                "catalogue",
            ).catalogue,
            expected,
        );
    }
});

test("unknown brands retain source text and unavailable references keep their empty shape", () => {
    const item = station({
        brand: "New Unmapped Brand",
        "site-features": "",
        restrictions: "",
    });
    const coded = api.codeStation(item, []);
    assert.equal(coded.brand, 0);
    assert.equal(coded.sourceNotes.brand, "New Unmapped Brand");
    assert.deepEqual(coded.siteFeatures, []);
    assert.equal(coded.restrictions, null);
    assert.deepEqual(api.codeStation(item, ["brand"]).brand, {
        code: 0,
        name: "New Unmapped Brand",
        logo: "/static/image/brand/generic.svg",
    });
});
