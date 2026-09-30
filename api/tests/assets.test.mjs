import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare, NoOpLog } from "miniflare";
import assetHeaders from "../src/asset-headers.json" with { type: "json" };

let worker;
const directory = fileURLToPath(new URL("../public", import.meta.url));
const registry = JSON.parse(
    await readFile(
        new URL(
            "../../../hacs-fuelwatch/custom_components/fuelwatch_wa/reference_data.json",
            import.meta.url,
        ),
        "utf8",
    ),
);
before(async () => {
    worker = new Miniflare(
        convertV4MiniflareOptions({
            modules: true,
            script: await readFile(
                new URL("../dist/test/index.js", import.meta.url),
                "utf8",
            ),
            compatibilityDate: "2026-09-29",
            compatibilityFlags: ["nodejs_compat"],
            cf: false,
            log: new NoOpLog(),
            assets: {
                directory,
                binding: "ASSETS",
                run_worker_first: ["/", "/v1", "/legacy"],
                routerConfig: { has_user_worker: true },
                assetConfig: {
                    headers: {
                        version: 2,
                        rules: {
                            "/static/image/brand/*": { set: assetHeaders },
                        },
                    },
                    html_handling: "none",
                    not_found_handling: "none",
                },
            },
            outboundService: () => {
                throw new Error("Images must not contact an origin");
            },
        }),
    );
});
after(async () => worker?.dispose());
const get = (path, options) =>
    worker.dispatchFetch(`https://worker.example${path}`, options);

test("every advertised brand logo is served by the real asset binding", async () => {
    for (const path of new Set(registry.brands.map((brand) => brand.logo))) {
        const response = await get(path);
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get("Content-Type"), "image/svg+xml");
        assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
        assert.equal(
            response.headers.get("Cache-Control"),
            "public, max-age=86400",
        );
        assert.match(
            response.headers.get("Content-Security-Policy"),
            /sandbox/,
        );
        assert.match(await response.text(), /<svg\b/);
    }
});

test("logo HEAD and conditional responses retain validators and unknown paths stay closed", async () => {
    const path = "/static/image/brand/bp.svg";
    const first = await get(path);
    const etag = first.headers.get("ETag");
    assert.ok(etag);
    await first.text();
    const head = await get(path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const unchanged = await get(path, { headers: { "If-None-Match": etag } });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");
    for (const path of [
        "/static/image/brand/missing.svg",
        "/brands/bp.svg",
        "/static/image/brand/%2e%2e%2fmanifest.json",
    ])
        assert.equal((await get(path)).status, 404);
    assert.equal((await get(path, { method: "POST" })).status, 405);
    // Static Assets serves GET/HEAD; image loads use simple CORS and need no preflight.
    assert.equal((await get(path, { method: "OPTIONS" })).status, 405);
});
