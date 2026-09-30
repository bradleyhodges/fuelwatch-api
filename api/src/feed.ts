import { parser } from "sax";
import { ApiError } from "./errors";
import {
    createFuelWatchParser,
    type FuelWatchProductId,
    type FuelWatchRssFeed,
    type FuelWatchRssItem,
    normaliseFuelWatchItem,
} from "./fuelwatch";
import { type FeedQuery, perthDate, perthTimestamp, shiftDate } from "./query";
import { normaliseStation, type StationFeed } from "./station";
import { version } from '../package.json';

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_STATIONS = 5000;
/** Snapshot provenance retained across station DTO changes so consumers can reject stale/wrong-day prices. */
interface SnapshotMetadata {
    /** Original fuel-price publisher; enrichment attribution remains on individual resources. */
    source: "fuelwatch.wa.gov.au";
    sourceDate: string;
    fetchedAt: string;
    validFrom: string;
    validUntil: string;
    publicationStatus: "available" | "empty" | "not_yet_published";
    copyright: string;
    documentation: string;
    issues: string;
    version: string;
}

/** Single-product clients retain their numeric product; combined responses enumerate all requested fuels. */
export type FeedMetadata = SnapshotMetadata &
    (
        | { product: FuelWatchProductId; products?: never }
        | { products: FuelWatchProductId[]; product?: never }
    );

const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected object");
    return value as Record<string, unknown>;
};
const text = (value: unknown, required = false, limit = 500): string => {
    if (value === undefined && !required) return "";
    if (
        typeof value !== "string" ||
        value.length > limit ||
        (required && !value.trim())
    )
        throw new Error("Invalid text field");
    return value.trim();
};

/** rss-parser discards duplicate fields and trailing input; validate before projection. */
function validateXml(xml: string): void {
    const validator = parser(true);
    const path: string[] = [];
    let rootSeen = false;
    let channels = 0;
    let stations = 0;
    let fields = new Set<string>();
    validator.onerror = (error) => {
        throw error;
    };
    validator.ondoctype = () => {
        throw new Error("Unsafe XML");
    };
    validator.onopentag = ({ name }) => {
        if (path.length === 0) {
            if (rootSeen || name !== "rss")
                throw new Error("Expected one RSS root");
            rootSeen = true;
        } else if (path.length === 1) {
            if (name !== "channel" || ++channels !== 1)
                throw new Error("Expected one channel");
        } else if (path.length === 2 && name === "item") {
            if (++stations > MAX_STATIONS) throw new Error("Too many stations");
            fields = new Set();
        } else if (path.length === 3 && path[2] === "item") {
            if (fields.has(name) && name !== "category")
                throw new Error("Duplicate quote field");
            fields.add(name);
        }
        if (path.length >= 32) throw new Error("XML nesting exceeds limit");
        path.push(name);
    };
    validator.onclosetag = () => {
        path.pop();
    };
    validator.ontext = (value) => {
        if (path.length === 0 && value.trim())
            throw new Error("Text outside RSS root");
    };
    validator.oncdata = (value) => {
        if (path.length === 0 && value.trim())
            throw new Error("CDATA outside RSS root");
    };
    validator.write(xml).close();
    if (!rootSeen || channels !== 1) throw new Error("Missing RSS channel");
}

/**
 * Validate a whole snapshot before publishing stations or writing to cache.
 * @param xml Size-bounded UTF-8 RSS from the transport boundary.
 * @param expectedDate Requested Perth source date, YYYY-MM-DD.
 * @returns Validated raw quotes, retaining source text needed for enrichment precedence.
 * @throws ApiError with invalid_feed; no partial price snapshot is published.
 */
export async function parseFeed(
    xml: string,
    expectedDate: string,
): Promise<FuelWatchRssFeed> {
    try {
        if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))
            throw new Error("Unsafe XML");
        validateXml(xml);
        const parsed: unknown = await createFuelWatchParser().parseString(xml);
        const feed = record(parsed);
        if (!Array.isArray(feed.items) || feed.items.length > MAX_STATIONS)
            throw new Error("Invalid station count");
        const identities = new Map<string, string>();
        const items: FuelWatchRssItem[] = [];
        for (const raw of feed.items) {
            const item = record(raw);

            const quote: FuelWatchRssItem = {
                title: text(item.title),
                description: text(item.description, false, 10_000),
                brand: text(item.brand) || "Independent",
                date: text(item.date, true),
                price: text(item.price, true),
                "trading-name": text(item["trading-name"], true),
                location: text(item.location, true),
                address: text(item.address, true),
                // Keep source presence so enrichment cannot replace an unparseable supplied number.
                phone: text(item.phone) || null,
                latitude: text(item.latitude, true),
                longitude: text(item.longitude, true),
                "site-features": text(item["site-features"], false, 10_000),
                restrictions: text(item.restrictions, false, 10_000),
            };

            if (quote.date !== expectedDate)
                throw new Error("Unexpected quote date");
            normaliseFuelWatchItem(quote);
            for (const key of [
                "content",
                "contentSnippet",
                "isoDate",
                "link",
                "guid",
                "pubDate",
                "creator",
                "summary",
            ] as const) {
                if (item[key] !== undefined)
                    quote[key] = text(item[key], false, 10_000);
            }
            // The live feed contains distinct neighbouring sites with the same address.
            const identity =
                `${quote.address}|${quote.location}|${Number(quote.latitude)}|${Number(quote.longitude)}`
                    .toLowerCase()
                    .replace(/\s+/g, " ");
            const serialized = JSON.stringify(quote);
            const existing = identities.get(identity);
            if (existing !== undefined && existing !== serialized)
                throw new Error("Conflicting station identity");
            if (existing === undefined) items.push(quote);
            identities.set(identity, serialized);
        }
        const result: FuelWatchRssFeed = {
            title: text(feed.title, true),
            items,
        };
        for (const key of [
            "link",
            "description",
            "language",
            "copyright",
            "lastBuildDate",
            "ttl",
        ] as const) {
            if (feed[key] !== undefined)
                result[key] = text(feed[key], false, 10_000);
        }
        if (feed.image !== undefined) {
            const image = record(feed.image);
            result.image = {
                url: text(image.url),
                title: text(image.title),
                link: text(image.link),
            };
        }
        return result;
    } catch (error) {
        console.warn({
            event: "feed_validation_failed",
            reason: error instanceof Error ? error.name : "unknown",
        });
        throw new ApiError(
            502,
            "invalid_feed",
            "FuelWatch returned an invalid price snapshot.",
        );
    }
}

/** Quote dates represent a 06:00–06:00 Perth price period, not UTC midnight. */
export function metadata(
    query: FeedQuery,
    count: number,
    now: number,
): FeedMetadata {
    const local = new Date(now + 8 * 3_600_000);
    const beforePublication =
        local.getUTCHours() * 60 + local.getUTCMinutes() < 14 * 60 + 30;
    return {
        source: "fuelwatch.wa.gov.au",
        ...(query.products.length === 1
            ? { product: query.products[0] }
            : { products: query.products }),
        sourceDate: query.sourceDate,
        fetchedAt: perthTimestamp(now),
        validFrom: `${query.sourceDate}T06:00:00.000+08:00`,
        validUntil: `${shiftDate(query.sourceDate, 1)}T06:00:00.000+08:00`,
        publicationStatus:
            count > 0
                ? "available"
                : query.sourceDate > perthDate(now) && beforePublication
                  ? "not_yet_published"
                  : "empty",
        copyright:
            "Copyright 2025 Department of Local Government, Industry Regulation and Safety (source data); Copyright 2026 Bradley Hodges (api). All rights reserved.",
        documentation: "https://docs.fuelwatch.oss.bhodges.me",
        issues: "https://github.com/bradleyhodges/fuelwatch-api/issues",
        version: version,
    };
}

/** Shape a validated feed into the normalized /v1 contract without performing provider lookups. */
export function compactFeed(feed: FuelWatchRssFeed): StationFeed {
    return {
        ...feed,
        items: feed.items.map((item) => normaliseStation(item)),
    };
}
