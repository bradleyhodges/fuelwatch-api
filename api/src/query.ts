import { ApiError } from "./errors";
import {
    brands,
    FUELWATCH_PRODUCTS,
    FUELWATCH_QUERY_PARAMETERS,
    type FuelWatchProductId,
    regions,
} from "./fuelwatch";

const DAY_MS = 86_400_000;
export const PERTH_OFFSET_MS = 8 * 3_600_000;
/** Bound multiplicative origin traffic before any cache lookup or network access. */
export const MAX_FILTER_COMBINATIONS = 24;
/** A canonical public selection and its finite, single-value upstream requests. */
export interface FeedQuery {
    /** Filters can be evaluated against the complete per-product D1 catalogue. */
    catalogue?: boolean;
    products: FuelWatchProductId[];
    sourceDate: string;
    upstream: URLSearchParams[];
    canonical: URLSearchParams;
}

/** Perth has no daylight saving; arithmetic never uses the host timezone. */
export const perthDate = (now: number): string =>
    new Date(now + PERTH_OFFSET_MS).toISOString().slice(0, 10);
/** ISO 8601 timestamp in AWST; fixed offset avoids dependence on the deployment/host timezone. */
export const perthTimestamp = (now: number): string =>
    new Date(now + PERTH_OFFSET_MS).toISOString().replace("Z", "+08:00");
export const shiftDate = (date: string, days: number): string =>
    new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
        .toISOString()
        .slice(0, 10);
const invalid = (): never => {
    throw new ApiError(
        400,
        "invalid_query",
        "Invalid or unsupported FuelWatch query.",
    );
};

/**
 * Validate case-insensitive query names/values and expand OR lists into upstream requests.
 * @param mode Catalogue mode selects all fuels by default and defers supported filters to D1
 * selection. Legacy mode preserves the RSS-shaped endpoint and internal single-product defaults.
 * @remarks FuelWatch silently ignores unsupported comma lists. Each expanded request contains
 * one value per filter; their union implements OR within a filter and AND across filters.
 * Repeated parameter names remain invalid even with different casing. List duplicates are harmless.
 * Day and Surrounding remain scalar because a snapshot has one price period and one search mode.
 */
export function parseQuery(
    params: URLSearchParams,
    now: number,
    mode: "legacy" | "catalogue" = "legacy",
): FeedQuery {
    if (
        params.size > FUELWATCH_QUERY_PARAMETERS.length ||
        params.toString().length > 1024
    )
        invalid();
    const normalized = new URLSearchParams();
    for (const [name, value] of params) {
        // JSON:API reserves the filter family for application-defined filtering semantics.
        // Short names remain intentional compatibility aliases and normalize to the same key.
        const filterName = /^filter\[([a-z]+)\]$/i.exec(name)?.[1] ?? name;
        const canonicalName = FUELWATCH_QUERY_PARAMETERS.find(
            (key) => key.toLowerCase() === filterName.toLowerCase(),
        );
        if (
            !canonicalName ||
            normalized.has(canonicalName) ||
            !value.trim() ||
            [...value].some(
                (character) =>
                    character.charCodeAt(0) < 32 ||
                    character.charCodeAt(0) === 127,
            )
        )
            return invalid();
        normalized.set(canonicalName, value.trim());
    }
    const filters = new Map<string, string[]>();
    for (const [name, catalogue] of [
        ["Product", FUELWATCH_PRODUCTS],
        ["Brand", brands],
        ["Region", regions],
    ] as const) {
        const raw =
            normalized.get(name) ??
            (name === "Product"
                ? mode === "catalogue"
                    ? Object.keys(FUELWATCH_PRODUCTS).join(",")
                    : "1"
                : null);
        if (raw === null) continue;
        const values = raw.split(",").map((value) => value.trim());
        if (
            values.some(
                (value) =>
                    !/^\d+$/.test(value) || !Object.hasOwn(catalogue, value),
            )
        )
            invalid();
        filters.set(
            name,
            [...new Set(values)].sort((a, b) => Number(a) - Number(b)),
        );
    }
    const suburb = normalized.get("Suburb");
    if (suburb !== null) {
        const values = suburb
            .split(",")
            .map((value) => value.trim().replace(/\s+/g, " ").toUpperCase());
        if (values.some((value) => !value || value.length > 100)) invalid();
        filters.set("Suburb", [...new Set(values)].sort());
    }
    // RSS has no region or surrounding-suburb membership. Keep those searches at the source.
    const catalogue =
        mode === "catalogue" &&
        !filters.has("Region") &&
        (!filters.has("Suburb") ||
            normalized.get("Surrounding")?.toLowerCase() === "no");
    const expandedFilters = catalogue
        ? new Map([...filters].filter(([name]) => name === "Product"))
        : filters;
    const combinations = [...expandedFilters.values()].reduce(
        (count, values) => count * values.length,
        1,
    );
    if (combinations > MAX_FILTER_COMBINATIONS) {
        throw new ApiError(
            400,
            "invalid_query",
            `Request at most ${MAX_FILTER_COMBINATIONS} product/brand/region/suburb combinations; split larger selections into separate requests.`,
        );
    }
    // Every product was checked against the finite catalogue above.
    const products = (filters.get("Product") ?? ["1"]).map(
        Number,
    ) as FuelWatchProductId[];
    const today = perthDate(now);
    const days = [shiftDate(today, -1), today, shiftDate(today, 1)];
    const names = ["yesterday", "today", "tomorrow"];
    const requested = normalized.get("Day")?.toLowerCase() ?? "today";
    let dayIndex = names.indexOf(requested);
    if (dayIndex < 0) {
        const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(requested);
        if (!match) return invalid();
        dayIndex = days.indexOf(`${match[3]}-${match[2]}-${match[1]}`);
        if (dayIndex < 0) invalid();
    }
    const sourceDate = days[dayIndex];
    const scalar = new URLSearchParams({
        Day: names[dayIndex],
    });
    const surrounding = normalized.get("Surrounding")?.toLowerCase();
    if (surrounding !== undefined) {
        if (surrounding !== "yes" && surrounding !== "no") invalid();
        scalar.set("Surrounding", surrounding);
    }
    let upstream = [scalar];
    const canonical = new URLSearchParams(scalar);
    for (const [name, values] of filters) {
        canonical.set(name, values.join(","));
        if (!expandedFilters.has(name)) continue;
        upstream = upstream.flatMap((params) =>
            values.map((value) => {
                const expanded = new URLSearchParams(params);
                expanded.set(name, value);
                return expanded;
            }),
        );
    }
    for (const params of upstream) params.sort();
    canonical.set("Day", sourceDate);
    canonical.sort();
    return { products, sourceDate, upstream, canonical, catalogue };
}

/** Only configuration chooses the origin; client input supplies validated filters. */
export function upstreamUrl(base: string, params: URLSearchParams): URL {
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("FUELWATCH_URL must be HTTPS without credentials");
    url.search = params.toString();
    url.hash = "";
    return url;
}
