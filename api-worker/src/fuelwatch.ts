import Parser from "rss-parser";

/**
 * Product identifiers accepted by the FuelWatch RSS endpoint.
 *
 * The values are part of the upstream query contract, so they intentionally
 * remain numeric rather than being replaced by local enum ordinals.
 */
export const FUELWATCH_PRODUCTS = {
    1: "Unleaded Petrol",
    2: "Premium Unleaded 95",
    4: "Diesel",
    5: "LPG",
    6: "Premium Unleaded 98",
    10: "E85",
    11: "Brand Diesel",
} as const;

export type FuelWatchProductId = keyof typeof FUELWATCH_PRODUCTS;

/** A date value accepted by FuelWatch's `Day` query parameter. */
export type FuelWatchDay = "today" | "tomorrow" | "yesterday";

export type ProductId = 1 | 2 | 4 | 5 | 6 | 10 | 11;
export type Suburb = string;
export type RegionCode =
    | 25
    | 26
    | 27
    | 15
    | 28
    | 63
    | 1
    | 30
    | 2
    | 16
    | 3
    | 29
    | 19
    | 4
    | 33
    | 5
    | 34
    | 35
    | 36
    | 6
    | 20
    | 37
    | 38
    | 39
    | 31
    | 7
    | 40
    | 41
    | 17
    | 21
    | 22
    | 42
    | 8
    | 43
    | 9
    | 44
    | 45
    | 10
    | 18
    | 32
    | 58
    | 46
    | 47
    | 48
    | 61
    | 23
    | 11
    | 49
    | 50
    | 60
    | 12
    | 62
    | 13
    | 51
    | 57
    | 14
    | 53
    | 24
    | 54
    | 55
    | 59
    | 56;
export type BrandCode =
    | 29
    | 2
    | 41
    | 34
    | 3
    | 4
    | 5
    | 52
    | 39
    | 6
    | 36
    | 32
    | 44
    | 24
    | 35
    | 25
    | 53
    | 7
    | 15
    | 10
    | 47
    | 30
    | 11
    | 48
    | 49
    | 42
    | 45
    | 40
    | 38
    | 26
    | 43
    | 14
    | 50
    | 46
    | 23
    | 27
    | 31
    | 37;
export type StateRegionCode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 98;

/**
 * The product IDs and their corresponding names.
 */
export const products: Record<ProductId, string> = {
    1: "Unleaded Petrol",
    2: "Premium Unleaded",
    4: "Diesel",
    5: "LPG",
    6: "98 RON",
    10: "E85",
    11: "Brand diesel",
};

/**
 * The region codes and their corresponding names.
 */
export const regions: Record<RegionCode, string> = {
    25: "Metro North",
    26: "Metro South",
    27: "Metro East/Hills",
    15: "Albany",
    28: "Augusta / Margaret River",
    63: "Bodallin",
    1: "Boulder",
    30: "Bridgetown / Greenbushes",
    2: "Broome",
    16: "Bunbury",
    3: "Busselton (Townsite)",
    29: "Busselton (Shire)",
    19: "Capel",
    4: "Carnarvon",
    33: "Cataby",
    5: "Collie",
    34: "Coolgardie",
    35: "Cunderdin",
    36: "Dalwallinu",
    6: "Dampier",
    20: "Dardanup",
    37: "Denmark",
    38: "Derby",
    39: "Dongara",
    31: "Donnybrook / Balingup",
    7: "Esperance",
    40: "Exmouth",
    41: "Fitzroy Crossing",
    17: "Geraldton",
    21: "Greenough",
    22: "Harvey",
    42: "Jurien",
    8: "Kalgoorlie",
    43: "Kambalda",
    9: "Karratha",
    44: "Kellerberrin",
    45: "Kojonup",
    10: "Kununurra",
    18: "Mandurah",
    32: "Manjimup",
    58: "Meckering",
    46: "Meekatharra",
    47: "Moora",
    48: "Mount Barker",
    61: "Munglinup",
    23: "Murray",
    11: "Narrogin",
    49: "Newman",
    50: "Norseman",
    60: "North Bannister",
    12: "Northam",
    62: "Northam (Shire)",
    13: "Port Hedland",
    51: "Ravensthorpe",
    57: "Regans Ford",
    14: "South Hedland",
    53: "Tammin",
    24: "Waroona",
    54: "Williams",
    55: "Wubin",
    59: "Wundowie",
    56: "York",
};

/**
 * The state region codes and their corresponding names.
 */
export const stateRegions: Record<StateRegionCode, string> = {
    1: "Gascoyne",
    2: "Goldfields-Esperance",
    3: "Great Southern",
    4: "Kimberley",
    5: "Mid-West",
    6: "Peel",
    7: "Pilbara",
    8: "South-West",
    9: "Wheatbelt",
    98: "Metro",
};

/** Filters supported by the public FuelWatch RSS endpoint. */
export interface FuelWatchQuery {
    product?: FuelWatchProductId;
    suburb?: string;
    region?: RegionCode;
    brand?: BrandCode;
    surrounding?: boolean;
    day?: FuelWatchDay;
}

/** Canonical, case-sensitive parameter names used by the upstream endpoint. */
export const FUELWATCH_QUERY_PARAMETERS = [
    "Product",
    "Suburb",
    "Region",
    "Brand",
    "Surrounding",
    "Day",
] as const;

export type FuelWatchQueryParameter =
    (typeof FUELWATCH_QUERY_PARAMETERS)[number];

/** The RSS channel image emitted by FuelWatch. */
export interface FuelWatchImage {
    url: string;
    title: string;
    link: string;
}

/**
 * FuelWatch channel fields after `rss-parser` has converted the RSS document.
 *
 * FuelWatch returns `ttl` as text. It represents the suggested cache lifetime
 * in minutes and can vary during the day.
 */
export interface FuelWatchChannelFields {
    title: string;
    link?: string;
    description?: string;
    language?: string;
    copyright?: string;
    lastBuildDate?: string;
    ttl?: string;
    image?: FuelWatchImage;
}

/**
 * The brand codes and their corresponding names.
 */
export const brands: Record<
    | 29
    | 2
    | 41
    | 34
    | 3
    | 4
    | 5
    | 52
    | 39
    | 6
    | 36
    | 32
    | 44
    | 24
    | 35
    | 25
    | 53
    | 7
    | 15
    | 10
    | 47
    | 30
    | 11
    | 48
    | 49
    | 42
    | 45
    | 40
    | 38
    | 26
    | 43
    | 14
    | 50
    | 46
    | 23
    | 27
    | 31
    | 37,
    string
> = {
    29: "7-Eleven",
    2: "Ampol",
    41: "Astron",
    34: "Atlas",
    3: "Better Choice",
    4: "BOC",
    5: "BP",
    52: "Broome Diesel",
    39: "Burk",
    6: "Caltex",
    36: "CGL fuel",
    32: "Costco",
    44: "Dunning's",
    24: "Eagle",
    35: "EG Ampol",
    25: "FastFuel 24/7",
    53: "Fuel Tech",
    7: "Gull",
    15: "Independent",
    10: "Liberty",
    47: "Maisey Fuels",
    30: "Metro Petroleum",
    11: "Mobil",
    48: "OMG Caltex",
    49: "OMG Metro",
    42: "OTR",
    45: "Perrys",
    40: "Petro Fuels",
    38: "Phoenix",
    26: "Puma",
    43: "Reddy Express",
    14: "Shell",
    50: "Solo",
    46: "UGO",
    23: "United",
    27: "Vibe",
    31: "WA Fuels",
    37: "X Convenience",
};

/**
 * FuelWatch-specific fields on each RSS item.
 *
 * These are strings because this type describes the lossless RSS-to-JSON
 * result. Use {@link normaliseFuelWatchItem} when numeric values are preferred.
 */
export interface FuelWatchItemFields {
    description: string;
    brand: string;
    date: string;
    price: string;
    "trading-name": string;
    location: string;
    address: string;
    phone: string | null;
    latitude: string;
    longitude: string;
    "site-features": string;
    restrictions: string;
}

export type FuelWatchRssItem = Parser.Item & FuelWatchItemFields;

export type FuelWatchRssFeed = FuelWatchChannelFields &
    Parser.Output<FuelWatchItemFields>;

/** Legacy /legacy JSON contract; /v1 uses FuelPriceDocument from jsonapi.ts. */
export interface FuelWatchApiResponse {
    feed: FuelWatchRssFeed;
}

/** A convenient, normalised representation of a FuelWatch station quote. */
export interface FuelWatchStationQuote {
    title: string;
    description: string;
    brand: string;
    date: string;
    price: number;
    tradingName: string;
    location: string;
    address: string;
    phone: string | null;
    latitude: number;
    longitude: number;
    siteFeatures: string | null;
    restrictions: string | null;
}

const FUELWATCH_ITEM_FIELDS: Array<keyof FuelWatchItemFields> = [
    "description",
    "brand",
    "date",
    "price",
    "trading-name",
    "location",
    "address",
    "phone",
    "latitude",
    "longitude",
    "site-features",
    "restrictions",
];

/**
 * Creates an RSS parser configured to retain every FuelWatch item field.
 *
 * `rss-parser` only keeps standard RSS fields unless custom fields are listed.
 */
export const createFuelWatchParser = (): Parser<
    FuelWatchChannelFields,
    FuelWatchItemFields
> =>
    new Parser<FuelWatchChannelFields, FuelWatchItemFields>({
        defaultRSS: 2,
        customFields: {
            item: FUELWATCH_ITEM_FIELDS,
        },
        xml2js: {
            emptyTag: "",
        },
    });

/**
 * Builds an upstream RSS URL without exposing arbitrary query parameters.
 */
export const buildFuelWatchRssUrl = (
    baseUrl: string,
    query: FuelWatchQuery = {},
): URL => {
    const url = new URL(baseUrl);

    setQueryParameter(url, "Product", query.product);
    setQueryParameter(url, "Suburb", query.suburb);
    setQueryParameter(url, "Region", query.region);
    setQueryParameter(url, "Brand", query.brand);
    setQueryParameter(
        url,
        "Surrounding",
        query.surrounding === undefined
            ? undefined
            : query.surrounding
              ? "yes"
              : "no",
    );
    setQueryParameter(url, "Day", query.day);

    return url;
};

/**
 * Builds an upstream URL by forwarding only FuelWatch's supported parameters.
 *
 * This is useful at a proxy boundary, where the incoming values have not yet
 * been validated into a {@link FuelWatchQuery}.
 */
export const forwardFuelWatchQuery = (
    baseUrl: string,
    searchParams: URLSearchParams,
): URL => {
    const url = new URL(baseUrl);

    for (const parameter of FUELWATCH_QUERY_PARAMETERS) {
        const value = searchParams.get(parameter);
        if (value !== null && value !== "") {
            url.searchParams.set(parameter, value);
        }
    }

    return url;
};

/**
 * Converts string-valued RSS fields into a convenient station quote.
 *
 * @throws {TypeError} if a required numeric field is not finite or is outside
 * its valid range.
 */
export const normaliseFuelWatchItem = (
    item: FuelWatchRssItem,
): FuelWatchStationQuote => ({
    title: item.title ?? "",
    description: item.description,
    brand: item.brand,
    date: item.date,
    price: parseFiniteNumber(item.price, "price", 0.001, 10000),
    tradingName: item["trading-name"],
    location: item.location,
    address: item.address,
    phone: item.phone ? nullableText(item.phone) : null,
    latitude: parseFiniteNumber(item.latitude, "latitude", -90, 90),
    longitude: parseFiniteNumber(item.longitude, "longitude", -180, 180),
    siteFeatures: nullableText(item["site-features"]),
    restrictions: nullableText(item.restrictions),
});

const setQueryParameter = (
    url: URL,
    name: string,
    value: string | number | undefined,
): void => {
    if (value !== undefined && value !== "") {
        url.searchParams.set(name, String(value));
    }
};

const nullableText = (value: string): string | null => {
    const text = value.trim();
    return text === "" || text === "--EMPTY--" ? null : text;
};

const parseFiniteNumber = (
    value: string,
    field: string,
    minimum: number,
    maximum = Number.POSITIVE_INFINITY,
): number => {
    if (
        typeof value !== "string" ||
        !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())
    )
        throw new TypeError(`Invalid FuelWatch ${field}`);
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
        throw new TypeError(`Invalid FuelWatch ${field}: ${value}`);
    }
    return number;
};
