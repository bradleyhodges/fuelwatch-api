import { ApiError } from "./errors";
import { parseFeed } from "./feed";
import type {
    FuelWatchProductId,
    FuelWatchRssFeed,
    FuelWatchRssItem,
} from "./fuelwatch";
import { type FeedQuery, upstreamUrl } from "./query";
import { stationKey } from "./station";
import { type Fetcher, fetchFeed } from "./upstream";

/** Raw validated quote with its originating fuel type, retained even when stations overlap. */
export type ProductQuote = FuelWatchRssItem & { product: FuelWatchProductId };
export type ProductFeed = Omit<FuelWatchRssFeed, "items"> & {
    items: ProductQuote[];
};

const CONCURRENCY = 3;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_QUOTES = 10_000;

/**
 * Fetch a complete selection with bounded parallelism, then merge by station AND fuel product.
 * @param base Operator-configured HTTPS FuelWatch origin.
 * @param query Validated finite expansion from parseQuery; never pass unvalidated client parameters.
 * @param options Injectable origin transport and deadline for deterministic failure tests.
 * @returns One validated snapshot; overlapping filters do not duplicate the same station/fuel quote.
 * @throws ApiError if any component fails, disagrees on a price, or exceeds the aggregate budget.
 * @remarks All components share an eight-second deadline, including queueing and transport retries.
 * Failure cancels in-flight fetches and stops new work. No partial snapshot can reach the HTTP cache.
 */
export async function loadSnapshot(
    base: string,
    query: FeedQuery,
    options: {
        fetcher?: Fetcher;
        signal?: AbortSignal;
        timeoutMs?: number;
    } = {},
): Promise<ProductFeed> {
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? 8000,
    );
    const signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;
    const quotes = new Map<
        string,
        { quote: ProductQuote; serialized: string }
    >();
    let channel: Omit<FuelWatchRssFeed, "items"> | undefined;
    let next = 0;
    let bytes = 0;
    let failure: unknown;
    const run = async () => {
        try {
            while (next < query.upstream.length && !signal.aborted) {
                const params = query.upstream[next++];
                const xml = await fetchFeed(upstreamUrl(base, params), {
                    fetcher: options.fetcher,
                    signal,
                });
                bytes += new TextEncoder().encode(xml).byteLength;
                if (bytes > MAX_TOTAL_BYTES)
                    throw new ApiError(
                        502,
                        "response_too_large",
                        "Combined FuelWatch response exceeds the size limit.",
                    );
                const feed = await parseFeed(xml, query.sourceDate);
                // Metadata for a single request stays untouched; a combined feed must not inherit
                // the first completed region's title, description or other region-specific fields.
                if (query.upstream.length === 1) {
                    const { items: _items, ...fields } = feed;
                    channel = fields;
                }
                const product = Number(
                    params.get("Product"),
                ) as FuelWatchProductId;
                for (const item of feed.items) {
                    const key = `${product}:${stationKey(item)}`;
                    const serialized = JSON.stringify(item);
                    const previous = quotes.get(key);
                    if (previous && previous.serialized !== serialized)
                        throw new ApiError(
                            502,
                            "invalid_feed",
                            "FuelWatch returned conflicting station quotes.",
                        );
                    if (!previous)
                        quotes.set(key, {
                            quote: { ...item, product },
                            serialized,
                        });
                    if (quotes.size > MAX_TOTAL_QUOTES)
                        throw new ApiError(
                            502,
                            "response_too_large",
                            "Combined FuelWatch response contains too many quotes.",
                        );
                }
            }
        } catch (error) {
            // Preserve the first failure; sibling abort errors must not replace the real diagnosis.
            failure ??= error;
            controller.abort();
        }
    };
    try {
        await Promise.all(
            Array.from(
                { length: Math.min(CONCURRENCY, query.upstream.length) },
                run,
            ),
        );
        if (failure) throw failure;
        if (signal.aborted)
            throw new ApiError(
                504,
                "upstream_timeout",
                "FuelWatch did not respond within the time limit.",
            );
        const items = [...quotes.values()].map((value) => value.quote);
        if (query.upstream.length > 1) {
            // Completion order is nondeterministic. Stable ordering keeps cache bodies and ETags consistent.
            items.sort(
                (a, b) =>
                    a.product - b.product ||
                    Number(a.price) - Number(b.price) ||
                    stationKey(a).localeCompare(stationKey(b)),
            );
        }
        return { ...(channel ?? { title: "FuelWatch prices" }), items };
    } finally {
        clearTimeout(timeout);
    }
}
