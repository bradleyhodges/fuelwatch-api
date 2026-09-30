import { describe, expect, it } from "vitest";
import {
    buildReferenceExample,
    getReferenceEnumValues,
    getReferenceShape,
    getReferenceTypeHref,
    groupDottedReferenceFields,
    tokenizeReferenceType,
} from "./reference-types";

describe("HTTP schema reference", () => {
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
    it("derives field nullability and presence from the published specification", () => {
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
