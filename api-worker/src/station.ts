import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { FuelWatchRssFeed, FuelWatchRssItem } from "./fuelwatch";
import { perthTimestamp } from "./query";

/** Canonical feature labels. Add aliases deliberately; never emit arbitrary source text here. */
export const FEATURES = [
    "Fuel Cards",
    "ATM",
    "Toilets",
    "Bottled Gas",
    "Trailer Hire",
    "EFTPOS",
    "Restaurant",
    "Carwash",
    "Workshop",
    "Air",
    "Water",
    "Ice",
    "Discount",
    "Voucher",
    "Bottled AdBlue",
    "Pumped AdBlue",
    "Truck Friendly",
    "Convenience Store",
    "Credit Cards",
    "Debit Cards",
    "Open 24 hours",
] as const;
/** A stable, human-readable feature identifier, suitable for exact client-side comparisons. */
export type Feature = (typeof FEATURES)[number];
/** Restrictions observed in FuelWatch. Unknown conditions remain in sourceNotes. */
export const RESTRICTIONS = [
    "Unmanned site (credit card charges may apply)",
    "Entry Permit Required",
    "Membership Required",
    "Low Aromatic Fuel",
] as const;
export type Restriction = (typeof RESTRICTIONS)[number];
/** Weekday ordering is explicit; it does not depend on locale or JavaScript's Sunday-first indexing. */
export const WEEKDAYS = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** Local Perth wall times: Closed, 00:00-24:00, or comma-separated HH:mm-HH:mm intervals. */
export type OpeningHours = Partial<Record<Weekday, string>>;

/** Unclassified source information is retained outside the controlled feature/restriction lists. */
export interface SourceNotes {
    /** Original source label when no stable brand code is assigned yet. */
    brand?: string;
    features?: string[];
    restrictions?: string[];
    openHours?: string;
    phone?: string;
}

/** Cached, verified Google place data; price, brand and FuelWatch coordinates are never enriched. */
export interface StationEnrichment {
    placeId: string;
    fetchedAt: string;
    expiresAt: string;
    postcode: string | null;
    phone: string | null;
    features: Feature[];
    hours: OpeningHours;
    is24Hours: boolean | null;
    googleMapsUri: string;
    attributions: { displayName: string; uri: string }[];
}

/** Station attributes within a JSON:API fuel-price resource. Missing values are never guessed. */
export interface Station {
    name: string;
    tradingName: string;
    brand: string;
    price: {
        /** Australian cents per litre; 195 means AUD 1.95/L. */
        perLitre: number;
        /** Start of the FuelWatch price period at 06:00 AWST, matching meta.validFrom. */
        asAt: string;
    };
    address: {
        street: string;
        suburb: string;
        state: "WA";
        postcode: string | null;
    };
    /** null means no reliable schedule was supplied; false means a known non-24-hour schedule. */
    is24Hours: boolean | null;
    phone: string | null;
    latitude: number;
    longitude: number;
    siteFeatures: Feature[];
    openHours?: OpeningHours;
    restrictions: Restriction[] | null;
    sourceNotes?: SourceNotes;
    /** Present only when Google fields were actually used; clients must display their attribution. */
    enrichment?: {
        provider: "Google Maps";
        placeId: string;
        fetchedAt: string;
        stale: boolean;
        fields: string[];
        googleMapsUri: string;
        attributions: StationEnrichment["attributions"];
    };
}

export type StationFeed = Omit<FuelWatchRssFeed, "items"> & {
    items: Station[];
};

/**
 * Parse a complete Australian/international phone value into E.164.
 * @param value Source phone text, including national formatting, or null.
 * @returns A validated E.164 number or null. Ambiguous lists and embedded prose are not extracted.
 */
export function normalisePhone(value: string | null): string | null {
    if (!value?.trim()) return null;
    const parsed = parsePhoneNumberFromString(value.trim(), {
        defaultCountry: "AU",
        extract: false,
    });
    return parsed?.isValid() && !parsed.ext ? parsed.number : null;
}

/**
 * Stable storage key independent of fuel, day, price and brand. Uses FuelWatch coordinates only.
 * @remarks Encoded JSON avoids delimiter collisions. It is not an authentication token or a public station ID.
 */
export function stationKey(item: FuelWatchRssItem): string {
    return JSON.stringify([
        item.address.trim().replace(/\s+/g, " ").toLowerCase(),
        item.location.trim().replace(/\s+/g, " ").toLowerCase(),
        Number(item.latitude),
        Number(item.longitude),
    ]);
}

/** Validate one canonical day value, allowing split shifts and next-day closing times. */
export function validHours(value: string): boolean {
    if (value === "Closed") return true;
    return (
        value.length <= 150 &&
        value.split(", ").every((interval) => {
            const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(interval);
            return (
                !!match &&
                Number(match[1]) < 24 &&
                Number(match[2]) < 60 &&
                Number(match[4]) < 60 &&
                (Number(match[3]) < 24 ||
                    (match[3] === "24" && match[4] === "00"))
            );
        })
    );
}

/**
 * Parse FuelWatch's weekday/range grammar without confusing hours with facilities.
 * @returns Known hours and 24-hour status. Unrecognised input is preserved for diagnostics.
 */
export function parseOpeningHours(raw: string): {
    hours: OpeningHours;
    is24Hours: boolean | null;
    unparsed?: string;
} {
    const value = raw.trim();
    if (!value) return { hours: {}, is24Hours: null };
    if (/^Open\s+24\s+hours[.,;\s]*$/i.test(value))
        return { hours: {}, is24Hours: true };
    const hours: OpeningHours = {};
    const chunks = value
        .replace(/^Open\s+/i, "")
        .split(/,\s*(?=[A-Za-z]+(?:-[A-Za-z]+)?:)/);
    for (const chunk of chunks) {
        const match = /^(\w+)(?:-(\w+))?:\s*(.+)$/.exec(chunk.trim());
        if (!match) return { hours: {}, is24Hours: null, unparsed: value };
        const from = WEEKDAYS.findIndex(
            (day) =>
                day.toLowerCase() === match[1].toLowerCase() ||
                day.slice(0, 3).toLowerCase() === match[1].toLowerCase(),
        );
        const to = match[2]
            ? WEEKDAYS.findIndex(
                  (day) =>
                      day.toLowerCase() === match[2].toLowerCase() ||
                      day.slice(0, 3).toLowerCase() === match[2].toLowerCase(),
              )
            : from;
        const times = /^(?:-|closed)$/i.test(match[3])
            ? "Closed"
            : match[3].split(/\s*(?:,|\/|&)\s*/).join(", ");
        if (from < 0 || to < 0 || !validHours(times))
            return { hours: {}, is24Hours: null, unparsed: value };
        for (let offset = 0; offset <= (to - from + 7) % 7; offset++) {
            const day = WEEKDAYS[(from + offset) % 7];
            if (hours[day] !== undefined && hours[day] !== times)
                return { hours: {}, is24Hours: null, unparsed: value };
            hours[day] = times;
        }
    }
    const values = Object.values(hours);
    return {
        hours,
        is24Hours:
            values.length === 7 &&
            values.every((time) => time === "00:00-24:00")
                ? true
                : values.some((time) => time !== "00:00-24:00")
                  ? false
                  : null,
    };
}

/**
 * FuelWatch facilities are often separated only by spaces. Match longest known labels first.
 * Stop at unknown text in each segment, avoiding false positives such as "No Toilets".
 */
function parseFeatures(raw: string): {
    features: Feature[];
    unknown: string[];
} {
    const labels = [...FEATURES].sort((a, b) => b.length - a.length);
    const found = new Set<Feature>();
    const unknown: string[] = [];
    for (const segment of raw.split(/[,;]/)) {
        let rest = segment.trim().replace(/\s+/g, " ");
        while (rest) {
            const label = labels.find(
                (value) =>
                    rest.toLowerCase() === value.toLowerCase() ||
                    rest.toLowerCase().startsWith(`${value.toLowerCase()} `),
            );
            if (!label) {
                unknown.push(rest);
                break;
            }
            found.add(label);
            rest = rest.slice(label.length).trim();
        }
    }
    return {
        features: FEATURES.filter((feature) => found.has(feature)),
        unknown,
    };
}

/**
 * Shape validated RSS into the public station DTO and merge optional cached enrichment.
 * @param item Fully validated FuelWatch quote. Do not call this on untrusted JSON.
 * @param extra Verified Google data for this exact FuelWatch station identity.
 * @param now Wall-clock milliseconds, injectable to test freshness without real timers.
 * @remarks FuelWatch street, suburb, name, brand, price and coordinates always win. Explicit source
 * phone/hours, including unparseable values retained in sourceNotes, block provider replacements.
 */
export function normaliseStation(
    item: FuelWatchRssItem,
    extra?: StationEnrichment,
    now = Date.now(),
): Station {
    const openIndex = item["site-features"].search(/\bOpen\b/i);
    const facilityText =
        openIndex < 0
            ? item["site-features"]
            : item["site-features"].slice(0, openIndex);
    const sourceHours =
        openIndex < 0 ? "" : item["site-features"].slice(openIndex);
    const parsed = parseOpeningHours(sourceHours);
    const facilities = parseFeatures(facilityText);
    const restrictions = new Set<Restriction>();
    const notes: SourceNotes = {};
    for (const part of item.restrictions
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean)) {
        const known = RESTRICTIONS.find(
            (value) => value.toLowerCase() === part.toLowerCase(),
        );
        if (known) restrictions.add(known);
        else {
            notes.restrictions ??= [];
            notes.restrictions.push(part);
        }
    }
    if (facilities.unknown.length) notes.features = facilities.unknown;
    if (parsed.unparsed) notes.openHours = parsed.unparsed;
    // FuelWatch uses this sentinel as an absent value, not as an explicit phone number.
    const sourcePhone = item.phone?.trim() === "--EMPTY--" ? null : item.phone;
    const phone = normalisePhone(sourcePhone);
    if (sourcePhone?.trim() && !phone) notes.phone = sourcePhone;
    const features = new Set(facilities.features);
    if (parsed.is24Hours) features.add("Open 24 hours");
    const result: Station = {
        name: item["trading-name"],
        tradingName: item["trading-name"],
        brand: item.brand,
        price: {
            perLitre: Number(item.price),
            // Set the "asAt" time to 6AM (see: https://www.consumerprotection.wa.gov.au/fuelwatch-and-fuel-prices)
            asAt: `${item.date}T06:00:00.000+08:00`,
        },
        address: {
            street: item.address,
            suburb: item.location,
            state: "WA",
            postcode: null,
        },
        is24Hours: parsed.is24Hours,
        phone,
        latitude: Number(item.latitude),
        longitude: Number(item.longitude),
        siteFeatures: [],
        restrictions: restrictions.size
            ? RESTRICTIONS.filter((value) => restrictions.has(value))
            : null,
    };
    const hours = { ...parsed.hours };
    // Stale enrichment is bounded to 30 days after retrieval, independently of price freshness.
    if (
        extra &&
        now >= Date.parse(extra.fetchedAt) &&
        now - Date.parse(extra.fetchedAt) < 30 * 86_400_000
    ) {
        const fields: string[] = [];
        if (extra.postcode) {
            result.address.postcode = extra.postcode;
            fields.push("address.postcode");
        }
        if (!sourcePhone?.trim() && extra.phone) {
            result.phone = extra.phone;
            fields.push("phone");
        }
        for (const feature of extra.features) {
            if (feature === "Open 24 hours" && sourceHours) continue;
            if (!features.has(feature)) {
                features.add(feature);
                fields.push("siteFeatures");
            }
        }
        // A malformed source schedule is still a supplied schedule; don't silently contradict it.
        if (!parsed.unparsed && parsed.is24Hours !== true) {
            for (const day of WEEKDAYS) {
                // Google's always-open shorthand has no day entries; expand it only into missing source days.
                const providerHours =
                    extra.is24Hours === true ? "00:00-24:00" : extra.hours[day];
                if (hours[day] === undefined && providerHours !== undefined) {
                    hours[day] = providerHours;
                    fields.push(`openHours.${day}`);
                }
            }
            if (result.is24Hours === null) {
                const values = Object.values(hours);
                const mergedStatus = values.some(
                    (value) => value !== "00:00-24:00",
                )
                    ? false
                    : values.length === 7
                      ? true
                      : !sourceHours
                        ? extra.is24Hours
                        : null;
                if (mergedStatus !== null) {
                    result.is24Hours = mergedStatus;
                    fields.push("is24Hours");
                }
            }
        }
        if (result.is24Hours === true) features.add("Open 24 hours");
        if (fields.length)
            result.enrichment = {
                provider: "Google Maps",
                placeId: extra.placeId,
                fetchedAt: perthTimestamp(Date.parse(extra.fetchedAt)),
                stale: now >= Date.parse(extra.expiresAt),
                fields: [...new Set(fields)],
                googleMapsUri: extra.googleMapsUri,
                attributions: extra.attributions,
            };
    }
    result.siteFeatures = FEATURES.filter((value) => features.has(value));
    if (Object.keys(hours).length && result.is24Hours !== true)
        result.openHours = hours;
    if (Object.keys(notes).length) result.sourceNotes = notes;
    return result;
}
