import { oramaStaticClient } from "fumadocs-core/search/client/orama-static";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("docs search route", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("exports a static search index that can find docs content", async () => {
        const response = await (GET as (request?: Request) => Promise<Response>)(
            new Request("https://example.test/api/search"),
        );

        expect(response.ok).toBe(true);

        const exportedIndex: unknown = await response.json();

        expect(Array.isArray(exportedIndex)).toBe(false);
        expect(exportedIndex).toMatchObject({ type: "advanced" });

        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.toString()
                      : input.url;

            if (url === "/api/search" || url.endsWith("/api/search")) {
                return Response.json(exportedIndex);
            }

            throw new Error(`Unexpected search index request: ${url}`);
        });

        const client = oramaStaticClient({
            from: "/api/search",
            search: { limit: 10 },
        });

        const results = await client.search("expansion");

        expect(
            results.some(
                (result) =>
                    result.url.includes("/expansion") ||
                    result.content.toLowerCase().includes("expansion"),
            ),
        ).toBe(true);
    });
});
