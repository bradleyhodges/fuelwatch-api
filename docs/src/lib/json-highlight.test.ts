import { describe, expect, it } from "vitest";
import { tokenizeJsonForHighlight } from "./json-highlight";

describe("JSON highlighting", () => {
    it("preserves JSON text while classifying common token types", () => {
        const json = `{
  "data": {
    "name": "Example Station",
    "active": true,
    "brand": 5,
    "phone": null
  }
}`;

        const tokens = tokenizeJsonForHighlight(json);

        expect(tokens.map((token) => token.text).join("")).toBe(json);
        expect(tokens).toContainEqual({ kind: "key", text: '"name"' });
        expect(tokens).toContainEqual({ kind: "string", text: '"Example Station"' });
        expect(tokens).toContainEqual({ kind: "boolean", text: "true" });
        expect(tokens).toContainEqual({ kind: "number", text: "5" });
        expect(tokens).toContainEqual({ kind: "null", text: "null" });
    });
});
