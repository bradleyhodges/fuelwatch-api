import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiExample, FieldTable, RequiredHeaders } from "./mdx";

describe("FuelWatch reference components", () => {
    it("retains expandable field tables for large schemas", () => {
        const children = Array.from({ length: 35 }, (_, index) => ({
            name: `field${index}`,
            type: "string",
            description: "Field",
        }));
        const html = renderToStaticMarkup(
            <FieldTable
                title="Fields"
                fields={[{ name: "data", type: "object", description: "Data", children }]}
            />,
        );
        expect(html).toContain("Show 5 more");
    });
    it("renders the validated expanded example with the real logo path", () => {
        const html = renderToStaticMarkup(<ApiExample name="Expanded" />);
        expect(html).toContain("/static/image/brand/bp.svg");
        expect(html).toContain("serviceStation");
        expect(html).not.toContain("Bearer");
    });
    it("documents public JSON:API request headers without authentication", () => {
        const html = renderToStaticMarkup(<RequiredHeaders />);
        expect(html).toContain("application/vnd.api+json");
        expect(html).not.toContain("Authorization");
    });
});
