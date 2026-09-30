import { describe, expect, it } from "vitest";
import codes from "./reference-codes.json";
import {
    buildReferenceExample,
    findReferenceShape,
    getFieldEnumValues,
    getReferenceEnumValues,
    getReferenceShape,
    getReferenceTypeHref,
    groupDottedReferenceFields,
    tokenizeReferenceType,
} from "./reference-types";

describe("HTTP schema reference", () => {
    it("pairs every controlled enum with its catalogue name and reference-table link", () => {
        for (const [type, entries, anchor] of [
            ["ProductCode", codes.products, "products"],
            ["BrandCode", codes.brands, "brands"],
            ["FeatureCode", codes.siteFeatures, "site-features"],
            ["RestrictionCode", codes.restrictions, "restrictions"],
        ] as const) {
            const expected = entries.map((entry) => ({
                value: String(entry.code),
                label: entry.name,
                href: `/docs/api-reference/codes#${anchor}`,
            }));
            expect(getReferenceEnumValues(`${type}[]`)).toEqual(expected);
            expect(getReferenceShape(type)?.fields[0].enumValues).toEqual(expected);
        }
        // Shared numeric IDs must never borrow names from another code family.
        expect(getReferenceEnumValues("integer")).toBeUndefined();
        expect(
            getReferenceEnumValues("BrandCode | Brand")?.find((item) => item.value === "5"),
        ).toMatchObject({ label: "BP" });
    });
    it("links actual API schemas while preserving punctuation and primitive types", () => {
        expect(tokenizeReferenceType("BrandCode | Brand")).toEqual([
            { text: "BrandCode", href: "/docs/api-reference/response-schema#brandcode" },
            { text: " | " },
            { text: "Brand", href: "/docs/api-reference/response-schema#brand" },
        ]);
        expect(getReferenceTypeHref("ImaginarySdkClient")).toBeUndefined();
        expect(getReferenceEnumValues("ProductCode[]")?.map((entry) => entry.value)).toEqual([
            "1",
            "2",
            "4",
            "5",
            "6",
            "10",
            "11",
        ]);
    });
    it("labels code fields within expanded reference objects", () => {
        for (const [objectType, codeType] of [
            ["Brand", "BrandCode"],
            ["SiteFeature", "FeatureCode"],
            ["Restriction", "RestrictionCode"],
        ]) {
            const field = getReferenceShape(objectType)?.fields.find(
                (field) => field.name === "code",
            );
            expect(field).toBeDefined();
            if (!field) throw new Error(`Missing ${objectType}.code`);
            expect(getFieldEnumValues(field)).toEqual(getReferenceEnumValues(codeType));
        }
    });
    it("derives field nullability and presence from the published specification", () => {
        expect(findReferenceShape("BrandCode | Brand")?.typeName).toBe("Brand");
        expect(findReferenceShape("ProductCode[]")).toBeUndefined();
        const station = getReferenceShape("StationAttributes");
        expect(station?.fields.find((field) => field.name === "phone")).toMatchObject({
            type: "string | null",
            required: true,
        });
        expect(station?.fields.find((field) => field.name === "enrichment")?.required).toBe(false);
        expect(
            getReferenceShape("ServiceStation")?.fields.find((field) => field.name === "attributes")
                ?.type,
        ).toBe("StationAttributes");
    });
    it("groups dotted names without mutating input and refuses invented response examples", () => {
        const fields = [{ name: "address.street", type: "string", description: "Street" }];
        expect(groupDottedReferenceFields(fields)[0].children?.[0].name).toBe("street");
        expect(fields[0].name).toBe("address.street");
        expect(buildReferenceExample(fields)).toBeUndefined();
        const example = buildReferenceExample([
            { name: "station", type: "ServiceStation", description: "Station" },
        ]);
        expect(example?.station).toMatchObject({
            type: "serviceStation",
            attributes: { brand: 5 },
        });
    });
});
