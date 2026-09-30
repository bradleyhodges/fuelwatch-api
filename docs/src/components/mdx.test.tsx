import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiExample, FieldTable, RequiredHeaders, TypeShape } from "./mdx";

describe("FuelWatch reference components", () => {
    it("renders readable, linked enum labels in query parameters and schema definitions", () => {
        for (const element of [
            <FieldTable
                key="query"
                title="Query parameters"
                fields={[
                    {
                        name: "product",
                        type: "ProductCode[]",
                        description:
                            "Comma-separated [product codes](/docs/api-reference/codes#products). Defaults to all seven.",
                    },
                ]}
            />,
            <TypeShape key="schema" typeName="ProductCode" />,
        ]) {
            const html = renderToStaticMarkup(element);
            expect(html).toMatch(
                /href="\/docs\/api-reference\/codes#products"[^>]*>Unleaded Petrol<\/a>/,
            );
            expect(html).toMatch(
                /href="\/docs\/api-reference\/codes#products"[^>]*>product codes<\/a>/,
            );
            expect(html).not.toContain("[product codes]");
        }
    });
    it("does not interpret raw HTML or unsafe Markdown links in descriptions", () => {
        const html = renderToStaticMarkup(
            <FieldTable
                fields={[
                    {
                        name: "example",
                        type: "string",
                        description:
                            "<img src=x onerror=alert(1)> [unsafe](javascript:alert) [external](https://example.com)",
                    },
                ]}
            />,
        );
        expect(html).not.toContain("<img");
        expect(html).not.toContain('<a href="javascript:');
        expect(html).not.toContain('<a href="https://example.com');
        expect(html).toContain("&lt;img");
    });
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
    it("renders a complete captured response with enrichment and its reproducible request", () => {
        const html = renderToStaticMarkup(<ApiExample name="Expanded" />);
        expect(html).toContain("Costco Perth Airport");
        expect(html).toContain("/static/image/brand/costco.svg");
        expect(html).toContain("Google Maps");
        expect(html).toContain("ChIJw1UkrSm5MioRiEMGrwrsOUI");
        expect(html).toContain("openHours");
        expect(html).toContain("Membership Required");
        expect(html).toContain("surrounding=no&amp;expand=brand,siteFeatures,restrictions");
        expect(html).toContain("Captured");
        expect(html).toContain("+08:00");
        expect(html).toContain("HTTP 200");
        expect(html).toContain("serviceStation");
        // The code block copy action reads a descendant pre; both request and response need one.
        expect(html.match(/role="region"[^>]*><pre[^>]*><code/g)).toHaveLength(2);
        expect(html).not.toContain("Bearer");
    });
    it("documents public JSON:API request headers without authentication", () => {
        const html = renderToStaticMarkup(<RequiredHeaders />);
        expect(html).toContain("application/vnd.api+json");
        expect(html).not.toContain("Authorization");
    });
    it("labels product expansion as derived from real data without claiming a captured HTTP response", () => {
        const html = renderToStaticMarkup(<ApiExample name="ProductExpanded" />);
        expect(html).toContain("expand=product");
        expect(html).toContain("Unleaded Petrol");
        expect(html).toContain("218.7");
        expect(html).toContain("enrichment");
        expect(html).toContain("Derived from production data");
        expect(html).not.toContain("HTTP 200");
    });
});
