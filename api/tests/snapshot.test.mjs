import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const output = fileURLToPath(
    new URL("../dist/test/snapshot.cjs", import.meta.url),
);
await build({
    stdin: {
        contents:
            'export * from "./src/snapshot"; export * from "./src/query";',
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
const query = (value) =>
    api.parseQuery(
        new URLSearchParams(value),
        Date.parse("2026-09-29T12:00:00+08:00"),
    );
const selection = () => query("product=1,2,6&brand=2,35");
const source = "https://source.example/rss";
const item = (number = 1, price = 185.9) =>
    `<item><brand>Example</brand><date>2026-09-29</date><price>${price}</price><trading-name>Example Station</trading-name><location>PERTH</location><address>${number} Test Road</address><latitude>-31.95</latitude><longitude>115.86</longitude></item>`;
const xml = (items = item()) =>
    `<rss version="2.0"><channel><title>FuelWatch</title>${items}</channel></rss>`;

test("combined snapshots bound concurrency and order results independently of completion order", async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const feed = await api.loadSnapshot(source, selection(), {
        fetcher: async (url) => {
            calls++;
            maximum = Math.max(maximum, ++active);
            const product = Number(url.searchParams.get("Product"));
            await new Promise((resolve) =>
                setTimeout(resolve, product === 1 ? 20 : 1),
            );
            active--;
            return new Response(xml(item(1, 180 + product)));
        },
    });
    assert.equal(calls, 6);
    assert.equal(maximum, 3);
    assert.deepEqual(
        feed.items.map((item) => [item.product, item.price]),
        [
            [1, "181"],
            [2, "182"],
            [6, "186"],
        ],
    );
});

test("a shared deadline cancels active requests and prevents queued filters from starting", async () => {
    let calls = 0;
    let aborted = 0;
    await assert.rejects(
        api.loadSnapshot(source, selection(), {
            timeoutMs: 30,
            fetcher: async (_url, { signal }) => {
                calls++;
                return new Promise((_resolve, reject) =>
                    signal.addEventListener(
                        "abort",
                        () => {
                            aborted++;
                            reject(signal.reason);
                        },
                        { once: true },
                    ),
                );
            },
        }),
        { code: "upstream_timeout" },
    );
    assert.equal(calls, 3);
    assert.equal(aborted, 3);
});

test("component validation failures retain their diagnosis while cancelling siblings", async () => {
    let calls = 0;
    let aborted = 0;
    await assert.rejects(
        api.loadSnapshot(source, selection(), {
            fetcher: async (_url, { signal }) => {
                if (++calls === 1) return new Response(xml(item(1, "bad")));
                return new Promise((_resolve, reject) =>
                    signal.addEventListener(
                        "abort",
                        () => {
                            aborted++;
                            reject(signal.reason);
                        },
                        { once: true },
                    ),
                );
            },
        }),
        { code: "invalid_feed" },
    );
    assert.equal(calls, 3);
    assert.equal(aborted, 2);
});

test("client cancellation prevents all upstream work", async () => {
    let calls = 0;
    await assert.rejects(
        api.loadSnapshot(source, selection(), {
            signal: AbortSignal.abort(),
            fetcher: async () => {
                calls++;
                return new Response(xml());
            },
        }),
        { code: "upstream_timeout" },
    );
    assert.equal(calls, 0);
});

test("the combined byte budget counts even empty and overlapping feeds", async () => {
    const largeEmptyFeed = xml(`<!--${"x".repeat(3 * 1024 * 1024)}-->`);
    await assert.rejects(
        api.loadSnapshot(source, selection(), {
            fetcher: async () => new Response(largeEmptyFeed),
        }),
        { code: "response_too_large" },
    );
});

test("individually valid feeds cannot exceed the combined quote limit", async () => {
    const largeFeed = xml(
        Array.from({ length: 3400 }, (_, index) => item(index)).join(""),
    );
    await assert.rejects(
        api.loadSnapshot(source, query("product=1,2,6"), {
            fetcher: async () => new Response(largeFeed),
        }),
        { code: "response_too_large" },
    );
});
