import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import specification from "../../public/openapi.json";
import codes from "./reference-codes.json";
import { getLLMText, source } from "./source";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ components: specification.components }, "fuelwatch-contract");
const validate = ajv.compile({ $ref: "fuelwatch-contract#/components/schemas/PriceDocument" });
const root = resolve(import.meta.dirname, "../../..");

describe("published HTTP contract", () => {
    it("is valid OpenAPI 3.1 with unique operations and only implemented public routes", async () => {
        await SwaggerParser.validate(resolve(root, "docs/public/openapi.json"));
        expect(Object.keys(specification.paths).sort()).toEqual([
            "/",
            "/legacy",
            "/static/image/brand/{filename}",
            "/v1",
        ]);
        const ids = Object.values(specification.paths).flatMap((path) =>
            Object.entries(path)
                .filter(([key]) => ["get", "head", "options"].includes(key))
                .map(([, operation]) => (operation as { operationId: string }).operationId),
        );
        expect(new Set(ids).size).toBe(ids.length);
        expect(specification.security).toEqual([]);
    });
    it.each(Object.entries(specification.components.examples))(
        "validates the %s example",
        (name, example) => {
            const schema =
                name === "Legacy"
                    ? "LegacyDocument"
                    : name === "InvalidProduct"
                      ? "ErrorDocument"
                      : "PriceDocument";
            const validateExample = ajv.compile({
                $ref: `fuelwatch-contract#/components/schemas/${schema}`,
            });
            expect(validateExample(example.value), JSON.stringify(validateExample.errors)).toBe(
                true,
            );
            const capture = example["x-capture"];
            expect(new URL(capture.url).origin).toBe("https://fuelwatch.oss.bhodges.me");
            expect(capture.capturedAt).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/);
            expect(createHash("sha256").update(JSON.stringify(example.value)).digest("hex")).toBe(
                capture.bodySha256,
            );
            expect(capture.status).toBe(name === "InvalidProduct" ? 400 : 200);
        },
    );
    it("rejects obsolete brands, mixed references, ambiguous product metadata and UTC timestamps", () => {
        const compact = specification.components.examples.Compact.value;
        const invalid = [
            { ...compact, meta: { ...compact.meta, product: 1 } },
            { ...compact, meta: { ...compact.meta, fetchedAt: "2026-09-29T08:00:00.000Z" } },
            ...[
                { brand: "BP" },
                { siteFeatures: [1, { code: 4, name: "ATM" }] },
                { price: { asAt: compact.meta.validFrom, products: { "3": 180 } } },
            ].map((fields) => ({
                ...compact,
                data: [
                    {
                        ...compact.data[0],
                        attributes: { ...compact.data[0].attributes, ...fields },
                    },
                ],
            })),
        ];
        for (const payload of invalid) expect(validate(payload)).toBe(false);
    });
    it("matches Worker products, brands, regions and controlled labels", async () => {
        const fuel = await readFile(resolve(root, "api/src/fuelwatch.ts"), "utf8");
        const station = await readFile(resolve(root, "api/src/station.ts"), "utf8");
        function numericMap(name: string) {
            const body = fuel.match(
                new RegExp(`export const ${name}[^=]*= \\{([\\s\\S]*?)\\n\\}`),
            )?.[1];
            if (!body) throw new Error(`Missing Worker map: ${name}`);
            return Object.fromEntries(
                [...body.matchAll(/(\d+): "([^"]+)"/g)].map((m) => [m[1], m[2]]),
            );
        }
        for (const [name, values] of [
            ["FUELWATCH_PRODUCTS", codes.products],
            ["regions", codes.regions],
            ["brands", codes.brands.filter((item) => item.code !== 0)],
        ] as const) {
            expect(Object.fromEntries(values.map((item) => [item.code, item.name]))).toEqual(
                numericMap(name),
            );
        }
        for (const [name, values] of [
            ["FEATURES", codes.siteFeatures],
            ["RESTRICTIONS", codes.restrictions],
        ] as const) {
            const body =
                station.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\]`))?.[1] ?? "";
            expect(values.map((item) => item.name).sort()).toEqual(
                [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort(),
            );
        }
        for (const [name, values] of [
            ["ProductCode", codes.products],
            ["BrandCode", codes.brands],
            ["FeatureCode", codes.siteFeatures],
            ["RestrictionCode", codes.restrictions],
        ] as const) {
            expect(specification.components.schemas[name].enum).toEqual(
                values.map((item) => item.code),
            );
            expect(new Set(values.map((item) => item.code)).size).toBe(values.length);
        }
        const errors = await readFile(resolve(root, "api/src/errors.ts"), "utf8");
        expect(
            specification.components.schemas.ApiError.properties.code.enum.slice().sort(),
        ).toEqual([...errors.split(";")[0].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort());
    });
});

describe("documentation navigation and examples", () => {
    const pages = source.getPages();
    it("exports schema fields, tables and JSON examples as readable Markdown", async () => {
        const schemas = source.getPage(["api-reference", "response-schema"]);
        const stations = source.getPage(["api-reference", "service-stations"]);
        if (!schemas || !stations) throw new Error("Missing API reference pages");
        const schemaText = await getLLMText(schemas);
        const stationText = await getLLMText(stations);
        expect(schemaText).toContain("googleMapsUri");
        expect(schemaText).toContain("## StationAttributes");
        expect(schemaText).not.toContain("<TypeShape");
        expect(stationText).toContain('"type": "serviceStation"');
        expect(stationText).toContain("| product | ProductCode[] |");
        expect(stationText).not.toMatch(/<(ApiExample|FieldTable|RequiredHeaders)/);
        expect(stationText).toContain("Costco Perth Airport");
        expect(stationText).toContain('"enrichment"');
        expect(stationText).toContain("surrounding=no");
        expect(stationText).toContain("Captured");
        expect(stationText).toContain("HTTP 200");
        for (const text of [schemaText, stationText]) {
            expect(text).toContain("[product codes](/docs/api-reference/codes#products)");
            expect(text).toContain("1 ([Unleaded Petrol](/docs/api-reference/codes#products))");
        }
        expect(
            schemas.data.structuredData.contents.some((item) =>
                item.content.includes("googleMapsUri"),
            ),
        ).toBe(true);
    });
    it("contains only FuelWatch API content with valid internal routes and schema anchors", async () => {
        expect(pages.length).toBe(16);
        const urls = new Set(pages.map((page) => page.url));
        for (const page of pages) {
            const mdx = await readFile(resolve(root, "docs/content/docs", page.path), "utf8");
            expect(mdx).not.toMatch(/linxio|ambulancewa|sdk-reference/i);
            for (const match of mdx.matchAll(/\]\((\/docs[^)]*)\)/g)) {
                const [path, hash] = match[1].split("#");
                expect(urls.has(path), `${page.path}: ${match[1]}`).toBe(true);
                if (hash) {
                    const target = pages.find((item) => item.url === path);
                    if (!target) throw new Error(`Missing page: ${path}`);
                    const toc = target.data.toc.map((entry) => entry.url);
                    expect(toc, `${page.path}: ${match[1]}`).toContain(`#${hash}`);
                }
            }
            for (const match of mdx.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)) {
                expect(() => JSON.parse(match[1]), page.path).not.toThrow();
            }
        }
        for (const schema of Object.keys(specification.components.schemas)) {
            const typesPage = await readFile(
                resolve(root, "docs/content/docs/api-reference/response-schema.mdx"),
                "utf8",
            );
            expect(typesPage).toContain(`typeName="${schema}"`);
        }
    });
    it("keeps all pages reachable in explicit navigation with no dangling entries", async () => {
        const nav = JSON.parse(
            await readFile(resolve(root, "docs/content/docs/meta.json"), "utf8"),
        );
        const apiNav = JSON.parse(
            await readFile(resolve(root, "docs/content/docs/api-reference/meta.json"), "utf8"),
        );
        const expected = nav.pages.flatMap((name: string) =>
            name === "api-reference"
                ? apiNav.pages.map(
                      (child: string) =>
                          `/docs/api-reference${child === "index" ? "" : `/${child}`}`,
                  )
                : `/docs${name === "index" ? "" : `/${name}`}`,
        );
        expect(expected.slice().sort()).toEqual(pages.map((page) => page.url).sort());
    });
});
