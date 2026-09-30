import data from "../../../hacs-fuelwatch/custom_components/fuelwatch_wa/reference_data.json";
import { ApiError } from "./errors";
import type { Station } from "./station";

/** Stable wire identifiers, shared with the installable HA adapter. Never recycle or renumber codes. */
export const REFERENCES = data;
export const EXPANDABLE_FIELDS = [
    "brand",
    "siteFeatures",
    "restrictions",
] as const;
export type ExpandableField = (typeof EXPANDABLE_FIELDS)[number];
export interface Reference {
    code: number;
    name: string;
}
export interface BrandReference extends Reference {
    logo: string;
}
export type CodedStation = Omit<
    Station,
    "brand" | "siteFeatures" | "restrictions"
> & {
    brand: number | BrandReference;
    siteFeatures: (number | Reference)[];
    restrictions: (number | Reference)[] | null;
};

const normalize = (name: string): string =>
    name.trim().replace(/\s+/g, " ").toLowerCase();
const byName = <T extends Reference>(items: T[]): Map<string, T> =>
    new Map(items.map((item) => [normalize(item.name), item]));
const brands = byName(data.brands.filter((brand) => brand.code !== 0));
const features = byName(data.siteFeatures);
const restrictions = byName(data.restrictions);

/**
 * Separate representation controls from source filters before parsing the FuelWatch query.
 * @remarks expand is case-insensitive and comma-delimited. Unknown/empty members and repeated
 * parameter names fail before cache or origin access. Expansion never enters D1 keys or RSS URLs.
 */
export function parseExpansion(params: URLSearchParams): {
    filters: URLSearchParams;
    expand: ExpandableField[];
} {
    const filters = new URLSearchParams();
    let raw: string | undefined;
    const invalid = (): never => {
        throw new ApiError(
            400,
            "invalid_query",
            "Expand brand, siteFeatures, restrictions, or all.",
        );
    };
    if (params.toString().length > 1024) invalid();
    for (const [name, value] of params) {
        if (name.toLowerCase() !== "expand") filters.append(name, value);
        else {
            if (
                raw !== undefined ||
                [...value].some(
                    (character) =>
                        character.charCodeAt(0) < 32 ||
                        character.charCodeAt(0) === 127,
                )
            )
                invalid();
            raw = value;
        }
    }
    if (raw === undefined) return { filters, expand: [] };
    const values = raw.split(",").map((name) => name.trim().toLowerCase());
    if (
        values.some(
            (name) =>
                name !== "all" &&
                !EXPANDABLE_FIELDS.some(
                    (field) => field.toLowerCase() === name,
                ),
        )
    )
        invalid();
    return {
        filters,
        expand: EXPANDABLE_FIELDS.filter(
            (field) =>
                values.includes("all") || values.includes(field.toLowerCase()),
        ),
    };
}

/** Map validated controlled labels to explicit immutable codes, never array ordinals. */
function reference<T extends Reference>(
    items: ReadonlyMap<string, T>,
    name: string,
): T {
    const result = items.get(normalize(name));
    if (!result)
        throw new Error("Controlled station label has no reference code");
    return result;
}

/**
 * Shape station references at the HTTP boundary; persisted RSS/enrichment labels stay lossless.
 * @remarks Unknown source brands use reserved code 0 and sourceNotes.brand, never a guessed brand.
 * Missing logo artwork uses the supplied generic SVG. Expansion adds names without extra lookups.
 */
export function codeStation(
    station: Station,
    expand: readonly ExpandableField[],
): CodedStation {
    const brand = brands.get(normalize(station.brand));
    const value: BrandReference = brand ?? {
        code: 0,
        name: station.brand,
        logo: "/static/image/brand/generic.svg",
    };
    return {
        ...station,
        brand: expand.includes("brand") ? value : value.code,
        siteFeatures: station.siteFeatures.map((name) => {
            const value = reference(features, name);
            return expand.includes("siteFeatures") ? value : value.code;
        }),
        restrictions:
            station.restrictions?.map((name) => {
                const value = reference(restrictions, name);
                return expand.includes("restrictions") ? value : value.code;
            }) ?? null,
        ...(!brand
            ? { sourceNotes: { ...station.sourceNotes, brand: station.brand } }
            : {}),
    };
}
