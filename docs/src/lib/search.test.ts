import { describe, expect, it } from "vitest";
import { docsSearchOptions } from "./search";

describe("docs search options", () => {
    it("uses the static client for the exported search index", () => {
        expect(docsSearchOptions.options).toMatchObject({
            api: "/api/search",
            type: "static",
        });
    });
});
