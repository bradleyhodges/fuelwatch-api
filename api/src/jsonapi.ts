import { ApiError } from "./errors";
import type { FeedMetadata } from "./feed";
import { FUELWATCH_PRODUCTS, type FuelWatchProductId } from "./fuelwatch";
import {
    type CodedStation,
    codeStation,
    type ExpandableField,
} from "./references";
import type { ProductFeed } from "./snapshot";
import {
    normaliseStation,
    type StationEnrichment,
    stationKey,
} from "./station";

/** JSON:API forbids adding charset to this media type. No extensions or profiles are applied. */
export const JSON_API_MEDIA_TYPE = "application/vnd.api+json";

/** A selected product's display name and unchanged price in Australian cents per litre. */
export interface ExpandedProductPrice {
    name: string;
    amount: number;
}

/** One station/date identity, independent of the products selected by the caller. */
export interface ServiceStationResource {
    type: "serviceStation";
    id: string;
    attributes: Omit<CodedStation, "price"> & {
        price: {
            asAt: string;
            /** All values use the same representation; unavailable products are omitted. */
            products: Partial<
                Record<FuelWatchProductId, number | ExpandedProductPrice>
            >;
        };
    };
}

/** JSON:API collection document; upstream RSS channel fields never cross this boundary. */
export interface FuelPriceDocument {
    jsonapi: { version: "1.1" };
    meta: FeedMetadata;
    data: ServiceStationResource[];
}

/**
 * Group all selected products into one JSON:API serviceStation resource per station/date.
 * @param expand References to populate with names. Product expansion wraps each numeric price
 * in { name, amount }; other unexpanded references remain numeric wire codes.
 * @remarks Hash each station only once per document, even when several requested fuels share it.
 * Names, brands, prices and enrichment updates do not change resource IDs. The existing integration
 * continues deriving its station selector separately so saved user selections survive this API change.
 */
export async function jsonApiDocument(
    feed: ProductFeed,
    meta: FeedMetadata,
    profiles: ReadonlyMap<string, StationEnrichment> = new Map(),
    now = Date.now(),
    expand: readonly ExpandableField[] = [],
): Promise<FuelPriceDocument> {
    const stations = new Map<string, ServiceStationResource["attributes"]>();
    const expandProducts = expand.includes("product");
    // Product order, rather than asynchronous fetch completion, chooses the station's source fields.
    for (const item of [...feed.items].sort((a, b) => a.product - b.product)) {
        const key = stationKey(item);
        let attributes = stations.get(key);
        if (!attributes) {
            const station = codeStation(
                normaliseStation(item, profiles.get(key), now),
                expand,
            );
            attributes = {
                ...station,
                price: { asAt: station.price.asAt, products: {} },
            };
            stations.set(key, attributes);
        }
        // Expand only at the response boundary so every variant shares the same source snapshots.
        const amount = Number(item.price);
        attributes.price.products[item.product] = expandProducts
            ? { name: FUELWATCH_PRODUCTS[item.product], amount }
            : amount;
    }
    const data = await Promise.all(
        [...stations].map(async ([key, attributes]) => {
            const identity = await crypto.subtle
                .digest("SHA-256", new TextEncoder().encode(key))
                .then((hash) =>
                    Array.from(new Uint8Array(hash), (byte) =>
                        byte.toString(16).padStart(2, "0"),
                    ).join(""),
                );
            return {
                type: "serviceStation" as const,
                id: `${meta.sourceDate}:${identity}`,
                attributes,
            };
        }),
    );
    return { jsonapi: { version: "1.1" }, meta, data };
}

/** Errors are documents too; keep diagnostic detail safe and HTTP statuses as JSON:API strings. */
export function jsonApiError(error: ApiError) {
    return {
        jsonapi: { version: "1.1" },
        errors: [
            {
                status: String(error.status),
                code: error.code,
                detail: error.message,
            },
        ],
    };
}

/** Split HTTP list/parameter separators without splitting quoted profile URIs or escaped quotes. */
function splitHeader(value: string, separator: string): string[] | undefined {
    const parts: string[] = [];
    let start = 0;
    let quoted = false;
    let escaped = false;
    for (let i = 0; i < value.length; i++) {
        const character = value[i];
        if (escaped) escaped = false;
        else if (quoted && character === "\\") escaped = true;
        else if (character === '"') quoted = !quoted;
        else if (!quoted && character === separator) {
            parts.push(value.slice(start, i).trim());
            start = i + 1;
        }
    }
    if (quoted || escaped) return undefined;
    parts.push(value.slice(start).trim());
    return parts;
}

/** Parse only HTTP media-range syntax; quality values are Accept weights, not media parameters. */
function mediaRange(
    value: string,
    accept: boolean,
):
    | {
          type: string;
          parameters: Map<string, string>;
          quality: number;
      }
    | undefined {
    const parts = splitHeader(value, ";");
    if (!parts?.length) return undefined;
    const type = parts[0].toLowerCase();
    if (!/^[!#$%&'*+.^_`|~\w-]+\/[!#$%&'*+.^_`|~\w-]+$/.test(type))
        return undefined;
    const parameters = new Map<string, string>();
    for (const part of parts.slice(1)) {
        const match =
            /^([!#$%&'*+.^_`|~\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+.^_`|~\w-]+))$/.exec(
                part,
            );
        if (!match) return undefined;
        const key = match[1].toLowerCase();
        if (parameters.has(key)) return undefined;
        parameters.set(key, (match[2] ?? match[3]).replace(/\\(.)/g, "$1"));
    }
    let quality = 1;
    if (accept && parameters.has("q")) {
        const weight = parameters.get("q") ?? "";
        if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(weight))
            return undefined;
        quality = Number(weight);
        parameters.delete("q");
    }
    return { type, parameters, quality };
}

/** We apply no extensions and ignore unrecognized profiles, as required by JSON:API 1.1. */
function supported(range: ReturnType<typeof mediaRange>): boolean {
    return (
        !!range &&
        !range.parameters.has("ext") &&
        [...range.parameters.keys()].every((key) => key === "profile")
    );
}

/**
 * Enforce JSON:API media negotiation BEFORE cache lookup, including conditional and HEAD requests.
 * @throws ApiError with 415 for unsupported Content-Type parameters or 406 for unacceptable responses.
 * @remarks Unknown profiles are ignored. An acceptable unmodified alternative can accompany an
 * unsupported extension. Short query aliases are a separate, documented compatibility choice.
 */
export function validateJsonApiHeaders(headers: Headers): void {
    const contentType = headers.get("Content-Type");
    if (
        contentType?.split(";")[0].trim().toLowerCase() ===
            JSON_API_MEDIA_TYPE &&
        !supported(mediaRange(contentType, false))
    ) {
        throw new ApiError(
            415,
            "unsupported_media_type",
            "Unsupported JSON:API Content-Type parameters.",
        );
    }
    const accept = headers.get("Accept");
    if (!accept) return;
    const entries =
        accept.length <= 8192 ? splitHeader(accept, ",") : undefined;
    const ranges = entries?.map((value) => mediaRange(value, true)) ?? [];
    const explicit =
        entries?.filter(
            (value) =>
                value.split(";")[0].trim().toLowerCase() ===
                JSON_API_MEDIA_TYPE,
        ) ?? [];
    // A more specific exclusion cannot be overridden by a broader positive wildcard.
    const wildcard = ranges.some(
        (range) =>
            range?.type === "application/*" && range.parameters.size === 0,
    )
        ? "application/*"
        : "*/*";
    const acceptable = explicit.length
        ? ranges.some(
              (range) =>
                  range?.type === JSON_API_MEDIA_TYPE &&
                  range.quality > 0 &&
                  supported(range),
          )
        : ranges.some(
              (range) =>
                  range &&
                  range.quality > 0 &&
                  range.type === wildcard &&
                  range.parameters.size === 0,
          );
    if (!acceptable)
        throw new ApiError(
            406,
            "not_acceptable",
            "Request application/vnd.api+json without unsupported extensions or media parameters.",
        );
}
