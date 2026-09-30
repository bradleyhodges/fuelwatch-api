import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";
import {
    convertV4MiniflareOptions,
    Miniflare,
    NoOpLog,
    Response,
} from "miniflare";

const script = await readFile(
    new URL("../dist/test/index.js", import.meta.url),
    "utf8",
);
const perthDate = () =>
    new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const xml = (fields = "", day = perthDate()) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>FuelWatch</title><item><title>Example</title><description>Station description</description><brand>Example</brand><date>${day}</date><price>185.9</price><trading-name>Example Station</trading-name><location>PERTH</location><address>1 Test Road</address><latitude>-31.95</latitude><longitude>115.86</longitude>${fields}</item></channel></rss>`;
let worker;
let requests;
let origin;
const migration = await readFile(
    new URL("../migrations/0001_station_enrichment.sql", import.meta.url),
    "utf8",
);

beforeEach(async () => {
    requests = [];
    origin = () =>
        new Response(xml(), { headers: { "Content-Type": "text/xml" } });
    worker = new Miniflare(
        convertV4MiniflareOptions({
            modules: true,
            script,
            compatibilityDate: "2026-09-29",
            compatibilityFlags: ["nodejs_compat"],
            cf: false,
            log: new NoOpLog(),
            bindings: {
                FUELWATCH_URL: "https://source.example/rss",
                GOOGLE_MAPS_API_KEY: "test-secret",
            },
            d1Databases: { FUELWATCH_DB: "worker-enrichment" },
            outboundService: (request) => {
                requests.push(request.url);
                return origin(request);
            },
        }),
    );
    const db = await worker.getD1Database("FUELWATCH_DB");
    const sql = await readFile(
        new URL("../migrations/0002_feed_cache.sql", import.meta.url),
        "utf8",
    );
    await db.batch(
        sql
            .replace(/--[^\n]*/g, "")
            .split(";")
            .filter((sql) => sql.trim())
            .map((sql) => db.prepare(sql)),
    );
});
afterEach(async () => {
    await worker.dispose();
});
const fetchWorker = (path = "/legacy", init) =>
    worker.dispatchFetch(`https://fuelwatch.example${path}`, init);

test("codes are the default and expansion changes representation without fetching more prices", async () => {
    origin = () =>
        new Response(
            xml(
                "<site-features>ATM, Toilets</site-features><restrictions>Membership Required</restrictions>",
            ).replace("<brand>Example</brand>", "<brand>BP</brand>"),
        );
    const compactResponse = await fetchWorker("/v1?product=1");
    const compact = await compactResponse.json();
    const attributes = compact.data[0].attributes;
    assert.equal(attributes.brand, 5);
    assert.deepEqual(attributes.siteFeatures, [4, 5]);
    assert.deepEqual(attributes.restrictions, [3]);
    assert.deepEqual(attributes.price.products, { 1: 185.9 });
    const expandedResponse = await fetchWorker("/v1?product=1&expand=all");
    const expanded = await expandedResponse.json();
    assert.deepEqual(expanded.data[0].attributes.brand, {
        code: 5,
        name: "BP",
        logo: "/static/image/brand/bp.svg",
    });
    assert.deepEqual(expanded.data[0].attributes.siteFeatures, [
        { code: 4, name: "ATM" },
        { code: 5, name: "Toilets" },
    ]);
    assert.deepEqual(expanded.data[0].attributes.restrictions, [
        { code: 3, name: "Membership Required" },
    ]);
    assert.deepEqual(expanded.data[0].attributes.price.products, {
        1: { name: "Unleaded Petrol", amount: 185.9 },
    });
    assert.equal(expanded.data[0].id, compact.data[0].id);
    assert.notEqual(
        expandedResponse.headers.get("ETag"),
        compactResponse.headers.get("ETag"),
    );
    const selective = await fetchWorker("/v1?PRODUCT=1&ExPaNd=BRAND,brand");
    const fields = (await selective.json()).data[0].attributes;
    assert.deepEqual(fields.brand, expanded.data[0].attributes.brand);
    assert.deepEqual(fields.siteFeatures, [4, 5]);
    assert.deepEqual(fields.price, attributes.price);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0]).searchParams.has("expand"), false);
});

test("product expansion names every selected fuel and reuses snapshots and equivalent rendered responses", async () => {
    origin = (request) =>
        new Response(
            xml().replace(
                "185.9",
                String(
                    180 +
                        Number(
                            new URL(request.url).searchParams.get("Product"),
                        ),
                ),
            ),
        );
    const response = await fetchWorker("/v1?expand=product");
    assert.equal(response.status, 200);
    const body = await response.json();
    const attributes = body.data[0].attributes;
    assert.deepEqual(attributes.price.products, {
        1: { name: "Unleaded Petrol", amount: 181 },
        2: { name: "Premium Unleaded 95", amount: 182 },
        4: { name: "Diesel", amount: 184 },
        5: { name: "LPG", amount: 185 },
        6: { name: "Premium Unleaded 98", amount: 186 },
        10: { name: "E85", amount: 190 },
        11: { name: "Brand Diesel", amount: 191 },
    });
    assert.equal(typeof attributes.brand, "number");
    assert.deepEqual(attributes.siteFeatures, []);
    assert.equal(attributes.restrictions, null);
    assert.equal(attributes.price.asAt, body.meta.validFrom);
    assert.equal(requests.length, 7);

    const compact = await fetchWorker("/v1");
    const compactBody = await compact.json();
    assert.equal(compactBody.data[0].id, body.data[0].id);
    assert.deepEqual(compactBody.meta, body.meta);
    assert.equal(compactBody.data[0].attributes.price.products[1], 181);
    assert.notEqual(compact.headers.get("ETag"), response.headers.get("ETag"));

    const equivalent = "/v1?ExPaNd=%20PRODUCT,product%20";
    const conditional = await fetchWorker(equivalent, {
        headers: { "If-None-Match": response.headers.get("ETag") },
    });
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), "");
    const head = await fetchWorker(equivalent, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("ETag"), response.headers.get("ETag"));
    assert.equal(await head.text(), "");

    const subset = await fetchWorker(
        "/v1?filter[product]=2,6&expand=brand,product",
    );
    const filtered = await subset.json();
    assert.equal(subset.status, 200);
    assert.equal(filtered.data[0].id, body.data[0].id);
    assert.deepEqual(filtered.data[0].attributes.price.products, {
        2: attributes.price.products[2],
        6: attributes.price.products[6],
    });
    assert.equal(typeof filtered.data[0].attributes.brand, "object");
    assert.equal(requests.length, 7);
    assert.ok(
        requests.every(
            (url) => !new URL(url).search.toLowerCase().includes("expand"),
        ),
    );
    assert.equal((await fetchWorker("/legacy?expand=product")).status, 400);
});

test("invalid expansion is rejected before upstream access", async () => {
    for (const query of [
        "expand=",
        "expand=nope",
        "expand=brand,",
        "expand=all,nope",
        "expand=brand&EXPAND=restrictions",
        "filter[expand]=brand",
    ]) {
        const response = await fetchWorker(`/v1?${query}`);
        assert.equal(response.status, 400, query);
    }
    assert.equal(requests.length, 0);
});

test("v1 defaults to every product grouped into one serviceStation and reuses its catalogue", async () => {
    origin = (request) =>
        new Response(
            xml().replace(
                "185.9",
                String(
                    180 +
                        Number(
                            new URL(request.url).searchParams.get("Product"),
                        ),
                ),
            ),
        );
    const response = await fetchWorker("/v1");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.meta.products, [1, 2, 4, 5, 6, 10, 11]);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].type, "serviceStation");
    assert.deepEqual(body.data[0].attributes.price.products, {
        1: 181,
        2: 182,
        4: 184,
        5: 185,
        6: 186,
        10: 190,
        11: 191,
    });
    assert.equal(body.data[0].attributes.price.perLitre, undefined);
    assert.equal(body.data[0].attributes.product, undefined);
    assert.equal(requests.length, 7);
    const subset = await fetchWorker(
        "/v1?product=2,6&suburb=perth&surrounding=no",
    );
    assert.equal(subset.status, 200);
    const filtered = await subset.json();
    assert.equal(filtered.data[0].id, body.data[0].id);
    assert.deepEqual(filtered.data[0].attributes.price.products, {
        2: 182,
        6: 186,
    });
    assert.equal(requests.length, 7);
    assert.equal(subset.headers.get("X-FuelWatch-Snapshot-Cache"), "HIT");
});

test("published feeds are shared through D1 across edge caches and equivalent filters", async () => {
    const first = await fetchWorker("/v1?brand=2,35&product=1,2");
    assert.equal(first.status, 200);
    const body = await first.json();
    const count = requests.length;
    const second = await worker.dispatchFetch(
        "https://another-edge.example/v1?FILTER[PRODUCT]=2,1&BRAND=35,2",
    );
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), body);
    assert.equal(requests.length, count);
    assert.equal(second.headers.get("X-FuelWatch-Snapshot-Cache"), "HIT");
});

test("legacy JSON keeps fuel fields and RSS content", async () => {
    const response = await fetchWorker();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.feed.items[0].price, "185.9");
    assert.equal(body.feed.items[0].brand, "Example");
    assert.equal(body.feed.items[0].content, "Station description");
});

test("public requests merge D1 data without contacting Google", async () => {
    const db = await worker.getD1Database("FUELWATCH_DB");
    await db.batch(
        migration
            .replace(/--[^\n]*/g, "")
            .split(";")
            .filter((sql) => sql.trim())
            .map((sql) => db.prepare(sql)),
    );
    const now = Date.now();
    const seed = {
        name: "Example Station",
        brand: "Example",
        street: "1 Test Road",
        suburb: "PERTH",
        latitude: -31.95,
        longitude: 115.86,
    };
    const cached = {
        placeId: "test_place",
        fetchedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 86400_000).toISOString(),
        postcode: "6000",
        phone: "+61899811151",
        features: ["Toilets"],
        hours: {},
        is24Hours: null,
        googleMapsUri:
            "https://www.google.com/maps/search/?api=1&query_place_id=test_place",
        attributions: [],
    };
    await db
        .prepare(
            "INSERT INTO station_enrichment(station_key, seed_json, last_seen_at, enrichment_json) VALUES (?, ?, ?, ?)",
        )
        .bind(
            JSON.stringify(["1 test road", "perth", -31.95, 115.86]),
            JSON.stringify(seed),
            now,
            JSON.stringify(cached),
        )
        .run();
    const response = await fetchWorker("/v1?product=1");
    assert.equal(response.status, 200);
    const station = (await response.json()).data[0].attributes;
    assert.equal(station.address.postcode, "6000");
    assert.equal(station.phone, "+61899811151");
    assert.equal(station.enrichment.provider, "Google Maps");
    assert.ok(station.enrichment.fetchedAt.endsWith("+08:00"));
    assert.equal(
        Date.parse(station.enrichment.fetchedAt),
        Date.parse(cached.fetchedAt),
    );
    assert.equal(requests.length, 1);
    assert.ok(
        requests.every((url) => new URL(url).hostname === "source.example"),
    );
    // A fresh HTTP representation must not extend the provider's own retirement deadline.
    cached.fetchedAt = new Date(
        Date.now() - 30 * 86400_000 + 5000,
    ).toISOString();
    cached.expiresAt = new Date(Date.now() + 5000).toISOString();
    await db
        .prepare("UPDATE station_enrichment SET enrichment_json = ?")
        .bind(JSON.stringify(cached))
        .run();
    const nearExpiry = await fetchWorker("/v1?Product=4");
    const ttl = Number(
        /s-maxage=(\d+)/.exec(nearExpiry.headers.get("Cache-Control"))?.[1] ??
            0,
    );
    assert.ok(ttl <= 5);
    assert.equal(
        (await nearExpiry.json()).data[0].attributes.address.postcode,
        "6000",
    );
});

test("legacy phone normalization preserves E.164 output", async () => {
    origin = () => new Response(xml("<phone>(08) 9981 1151</phone>"));
    const response = await fetchWorker();
    assert.equal((await response.json()).feed.items[0].phone, "+61899811151");
});

test("versioned JSON excludes redundant descriptions and exposes provenance", async () => {
    const response = await fetchWorker("/v1?Product=4");
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["data", "jsonapi", "meta"]);
    assert.equal(body.jsonapi.version, "1.1");
    assert.equal(body.meta.product, 4);
    assert.equal(body.meta.sourceDate, perthDate());
    assert.equal(body.meta.publicationStatus, "available");
    assert.equal(body.data[0].type, "serviceStation");
    assert.equal(typeof body.data[0].id, "string");
    const attributes = body.data[0].attributes;
    assert.equal(attributes.product, undefined);
    assert.equal(attributes.tradingName, "Example Station");
    assert.deepEqual(attributes.siteFeatures, []);
    assert.equal(attributes.content, undefined);
    assert.equal(attributes.contentSnippet, undefined);
    assert.equal(attributes.description, undefined);
    assert.equal(attributes.price.products[4], 185.9);
    assert.equal(attributes.price.asAt, `${perthDate()}T06:00:00.000+08:00`);
    assert.equal(attributes.address.suburb, "PERTH");
    assert.ok(
        body.meta.fetchedAt && body.meta.validFrom && body.meta.validUntil,
    );
    for (const field of ["fetchedAt", "validFrom", "validUntil"])
        assert.ok(body.meta[field].endsWith("+08:00"), field);
    assert.equal(
        response.headers.get("Content-Type"),
        "application/vnd.api+json",
    );
    const checkKeys = (value) => {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
            assert.ok(
                !["title", "image", "schemaVersion", "description"].includes(
                    key,
                ),
                key,
            );
            assert.ok(!key.includes("-"), key);
            checkKeys(child);
        }
    };
    checkKeys(body);
});

test("JSON API errors use errors arrays with safe string status codes", async () => {
    const response = await fetchWorker("/v1?product=999");
    assert.equal(response.status, 400);
    assert.equal(
        response.headers.get("Content-Type"),
        "application/vnd.api+json",
    );
    const body = await response.json();
    assert.equal(body.data, undefined);
    assert.equal(body.errors[0].status, "400");
    assert.equal(body.errors[0].code, "invalid_query");
    assert.equal(typeof body.errors[0].detail, "string");
    assert.equal(body.errors[0].title, undefined);
    assert.equal(requests.length, 0);
});

test("JSON API content negotiation rejects unsupported media parameters before cache access", async () => {
    const valid = await fetchWorker("/v1?product=1", {
        headers: { Accept: "application/vnd.api+json" },
    });
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get("Vary"), "Accept");
    await valid.text();
    const count = requests.length;
    for (const [headers, status] of [
        [{ Accept: "application/vnd.api+json; charset=utf-8" }, 406],
        [
            {
                Accept: 'application/vnd.api+json; ext="https://example.com/unknown"',
            },
            406,
        ],
        [{ Accept: "application/vnd.api+json;q=0, */*;q=1" }, 406],
        [{ Accept: "application/*;q=0, */*;q=1" }, 406],
        [{ Accept: "*/*;q=1, application/*;q=0" }, 406],
        [{ Accept: "application/json" }, 406],
        [{ "Content-Type": "application/vnd.api+json; charset=utf-8" }, 415],
        [
            {
                "Content-Type":
                    'application/vnd.api+json; ext="https://example.com/unknown"',
            },
            415,
        ],
    ]) {
        const response = await fetchWorker("/v1?product=1", { headers });
        assert.equal(response.status, status, JSON.stringify(headers));
        assert.equal((await response.json()).errors[0].status, String(status));
        assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
    assert.equal(requests.length, count);
    for (const Accept of [
        "*/*",
        "application/*",
        'application/vnd.api+json;profile="https://example.com/profile,a;b"',
        'application/vnd.api+json;ext="https://example.com/unknown", application/vnd.api+json;q=0.9',
        "application/vnd.api+json;charset=utf-8, application/vnd.api+json",
    ]) {
        const response = await fetchWorker("/v1?product=1", {
            headers: { Accept },
        });
        assert.equal(response.status, 200, Accept);
        await response.text();
    }
});

test("JSON API IDs are stable across product selections and rebranding", async () => {
    const first = (await (await fetchWorker("/v1?product=1,2")).json()).data;
    assert.equal(first.length, 1);
    origin = () =>
        new Response(
            xml()
                .replace("Example Station", "New Name")
                .replace("185.9", "199.9"),
        );
    // A source-side region query bypasses the previously warmed unfiltered selection.
    const renamed = (
        await (await fetchWorker("/v1?product=1&region=25")).json()
    ).data;
    assert.equal(renamed[0].id, first[0].id);
    assert.equal(renamed[0].attributes.price.products[1], 199.9);
});

test("unknown paths and unsupported methods do not contact upstream", async () => {
    assert.equal((await fetchWorker("/missing")).status, 404);
    const post = await fetchWorker("/legacy", { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("Allow"), "GET, HEAD, OPTIONS");
    assert.equal(requests.length, 0);
});

test("root redirects to v1 with list filters intact without fetching upstream", async () => {
    const response = await fetchWorker("/?brand=2,35&product=1,2,6", {
        redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.equal(
        response.headers.get("Location"),
        "https://fuelwatch.example/v1?brand=2,35&product=1,2,6",
    );
    assert.equal(requests.length, 0);
});

test("root redirects preserve CORS and enforce method handling", async () => {
    const redirect = await fetchWorker("/", {
        redirect: "manual",
        headers: { Origin: "https://client.example" },
    });
    assert.equal(redirect.headers.get("Access-Control-Allow-Origin"), "*");
    const preflight = await fetchWorker("/", {
        redirect: "manual",
        method: "OPTIONS",
        headers: {
            Origin: "https://client.example",
            "Access-Control-Request-Method": "GET",
        },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(
        (await fetchWorker("/", { redirect: "manual", method: "POST" })).status,
        405,
    );
    assert.equal(requests.length, 0);
});

test("cold HEAD succeeds and shares the GET cache entry", async () => {
    const head = await fetchWorker("/v1?product=1", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    // Cache writes run in waitUntil: poll only the local runtime until visible.
    for (let i = 0; i < 20; i++) {
        const result = await fetchWorker("/v1?product=1");
        await result.text();
        if (result.headers.get("X-FuelWatch-Cache") === "HIT") return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("GET never hit the HEAD-populated cache");
});

test("CORS preflight does not require Access-Control-Request-Headers", async () => {
    const response = await fetchWorker("/legacy", {
        method: "OPTIONS",
        headers: {
            Origin: "https://app.example",
            "Access-Control-Request-Method": "GET",
        },
    });
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(
        response.headers.get("Access-Control-Allow-Methods"),
        "GET, HEAD, OPTIONS",
    );
    assert.equal(requests.length, 0);
});

test("conditional GET and HEAD return a bodyless 304 for a cached representation", async () => {
    let response;
    for (let i = 0; i < 20; i++) {
        response = await fetchWorker("/v1?product=1");
        await response.text();
        if (response.headers.get("X-FuelWatch-Cache") === "HIT") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(response.headers.get("X-FuelWatch-Cache"), "HIT");
    const count = requests.length;
    for (const method of ["GET", "HEAD"]) {
        const result = await fetchWorker("/v1?product=1", {
            method,
            headers: { "If-None-Match": `W/${response.headers.get("ETag")}` },
        });
        assert.equal(result.status, 304);
        assert.equal(await result.text(), "");
        assert.equal(result.headers.get("X-FuelWatch-Fresh-Until"), null);
    }
    assert.equal(requests.length, count);
});

test("valid empty snapshots have a short explicit cache lifetime", async () => {
    origin = () =>
        new Response(
            '<rss version="2.0"><channel><title>FuelWatch</title></channel></rss>',
        );
    const response = await fetchWorker("/v1?product=1");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.meta.publicationStatus, "empty");
    assert.deepEqual(body.data, []);
    const ttl = Number(
        /s-maxage=(\d+)/.exec(response.headers.get("Cache-Control"))?.[1] ?? 0,
    );
    assert.ok(ttl <= 30);
});

test("denied upstream responses return a safe uncached error without retries", async () => {
    origin = () => new Response("<html>Forbidden</html>", { status: 403 });
    const response = await fetchWorker();
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await response.json()).error.code, "upstream_denied");
    assert.equal(requests.length, 1);
});

test("Retry-After is respected and an upstream 503 never becomes cached 200", async () => {
    origin = () =>
        new Response(xml(), { status: 503, headers: { "Retry-After": "120" } });
    const response = await fetchWorker();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "120");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(requests.length, 1);
});

test("temporary upstream failure recovers with a bounded retry", async () => {
    origin = () =>
        requests.length === 1
            ? new Response("Unavailable", { status: 503 })
            : new Response(xml());
    const response = await fetchWorker();
    assert.equal(response.status, 200);
    assert.equal(requests.length, 2);
});

for (const [name, body] of [
    ["invalid price", () => xml().replace("185.9", "NaN")],
    ["zero price", () => xml().replace("185.9", "0")],
    ["blank latitude", () => xml().replace("-31.95", " ")],
    ["invalid coordinate", () => xml().replace("-31.95", "999")],
    ["wrong source date", () => xml("", "2000-01-01")],
    [
        "missing identity",
        () => xml().replace("<address>1 Test Road</address>", ""),
    ],
    ["unsafe XML", () => `<!DOCTYPE rss [<!ENTITY x "bad">]>${xml()}`],
    ["malformed XML", () => "<rss><channel>"],
])
    test(`${name} is rejected before cache publication`, async () => {
        origin = () => new Response(body());
        const response = await fetchWorker();
        assert.equal(response.status, 502);
        assert.equal((await response.json()).error.code, "invalid_feed");
        assert.equal(requests.length, 1);
    });

test("oversized decompressed input is rejected", async () => {
    origin = () =>
        new Response(
            xml().replace("Station description", "x".repeat(4 * 1024 * 1024)),
        );
    const response = await fetchWorker();
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "response_too_large");
});

test("unrelated upstream headers cannot break caching or leak into JSON", async () => {
    origin = () =>
        new Response(xml(), {
            headers: {
                "Content-Type": "text/xml",
                "Set-Cookie": "session=private",
                Vary: "*",
                ETag: '"xml-hash"',
                "Cache-Control": "public, max-age=86400",
            },
        });
    const response = await fetchWorker();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.notEqual(response.headers.get("ETag"), '"xml-hash"');
    assert.notEqual(response.headers.get("Vary"), "*");
    assert.match(response.headers.get("Cache-Control"), /s-maxage=/);
});

test("invalid, duplicate and unknown query values never contact upstream", async () => {
    for (const query of [
        "Product=999",
        "Day=nonsense",
        "Product=1&Product=4",
        "nonce=1",
        "Surrounding=maybe",
        "Region=999",
        "Brand=-1",
    ]) {
        assert.equal(
            (await fetchWorker(`/legacy?${query}`)).status,
            400,
            query,
        );
    }
    assert.equal(requests.length, 0);
});

test("equivalent query order and absolute dates resolve to one cache key", async () => {
    const [year, month, day] = perthDate().split("-");
    await (await fetchWorker("/legacy?Product=4&Day=today")).text();
    let result;
    for (let i = 0; i < 20; i++) {
        result = await fetchWorker(
            `/legacy?Day=${day}%2F${month}%2F${year}&Product=4`,
        );
        await result.text();
        if (result.headers.get("X-FuelWatch-Cache") === "HIT") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(result.headers.get("X-FuelWatch-Cache"), "HIT");
    assert.equal(new URL(requests[0]).searchParams.get("Day"), "today");
});

test("case-insensitive brand/product selections reuse complete product catalogues", async () => {
    origin = (request) => {
        const params = new URL(request.url).searchParams;
        assert.equal(params.get("Brand"), null);
        const product = Number(params.get("Product"));
        const stations = ["Ampol", "EG Ampol", "BP"]
            .map((brand, i) =>
                xml()
                    .match(/<item>.*<\/item>/s)[0]
                    .replace(
                        "<brand>Example</brand>",
                        `<brand>${brand}</brand>`,
                    )
                    .replace("1 Test Road", `${i + 1} Test Road`)
                    .replace("185.9", String(180 + product)),
            )
            .join("");
        return new Response(
            `<rss version="2.0"><channel><title>FuelWatch</title>${stations}</channel></rss>`,
        );
    };
    const first = await fetchWorker("/v1?brand=2,35&product=1,2,6&day=ToDaY");
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.deepEqual(body.meta.products, [1, 2, 6]);
    assert.deepEqual(
        body.data.map(({ attributes: a }) => [a.brand, a.price.products]),
        [
            [2, { 1: 181, 2: 182, 6: 186 }],
            [35, { 1: 181, 2: 182, 6: 186 }],
        ],
    );
    assert.equal(requests.length, 3);
    const changed = await fetchWorker("/v1?BRAND=5&PRODUCT=6,2,1");
    assert.equal((await changed.json()).data[0].attributes.brand, 5);
    assert.equal(requests.length, 3);
    assert.equal(changed.headers.get("X-FuelWatch-Snapshot-Cache"), "HIT");
    const equivalent = await fetchWorker(
        "/v1?FILTER[PRODUCT]=6,2,1&FILTER[BRAND]=35,2",
    );
    assert.deepEqual(await equivalent.json(), body);
});

test("overlapping region and suburb lists deduplicate stations per fuel product", async () => {
    const response = await fetchWorker(
        "/v1?region=25,26&suburb=PERTH,fremantle&product=1,2",
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(requests.length, 8);
    assert.deepEqual(
        body.data.map((item) => item.attributes.price.products),
        [{ 1: 185.9, 2: 185.9 }],
    );
    const single = await fetchWorker("/v1?product=1,1&region=25,26");
    const singleBody = await single.json();
    assert.equal(singleBody.meta.product, 1);
    assert.equal(singleBody.meta.products, undefined);
    assert.equal(singleBody.data.length, 1);
    assert.equal(singleBody.data[0].attributes.price.products[1], 185.9);
});

test("a failed component never produces or caches a partial combined snapshot", async () => {
    let broken = true;
    origin = (request) =>
        new Response(
            broken && new URL(request.url).searchParams.get("Product") === "2"
                ? xml().replace("185.9", "bad")
                : xml(),
        );
    const first = await fetchWorker("/v1?product=1,2");
    assert.equal(first.status, 502);
    assert.equal(first.headers.get("Cache-Control"), "no-store");
    assert.equal((await first.json()).errors[0].code, "invalid_feed");
    broken = false;
    const retry = await fetchWorker("/v1?PRODUCT=2,1");
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).data.length, 1);
    assert.equal(retry.headers.get("X-FuelWatch-Cache"), "MISS");
});

test("conflicting prices across overlapping filters fail the complete response", async () => {
    origin = (request) =>
        new Response(
            xml().replace(
                "185.9",
                new URL(request.url).searchParams.get("Region") === "25"
                    ? "181"
                    : "182",
            ),
        );
    const response = await fetchWorker("/v1?region=25,26");
    assert.equal(response.status, 502);
    assert.equal((await response.json()).errors[0].code, "invalid_feed");
});

test("legacy supports product lists and keeps its cache separate from v1", async () => {
    const response = await fetchWorker("/legacy?product=1,2");
    assert.equal(response.status, 200);
    assert.deepEqual(
        (await response.json()).feed.items.map((item) => [
            item.product,
            item.price,
        ]),
        [
            [1, "185.9"],
            [2, "185.9"],
        ],
    );
    const compact = await fetchWorker("/v1?product=1,2");
    assert.equal(
        (await compact.json()).data[0].attributes.price.products[1],
        185.9,
    );
});
