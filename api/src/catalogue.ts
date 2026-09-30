import { ApiError } from "./errors";
import { type BrandCode, brands } from "./fuelwatch";
import type { FeedQuery } from "./query";
import type { ProductQuote } from "./snapshot";
import { type CachedSnapshot, loadCachedSnapshot } from "./snapshot-cache";

const normalized = (value: string): string =>
    value.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Serve selections from the same per-product D1 extract refreshed by the hourly cron.
 * @param query Validated selection from parseQuery in catalogue mode.
 * @returns Complete selected quotes with the oldest contributing fetch time and earliest expiry.
 * @remarks Brand and exact-suburb changes never create another origin selection. Region and
 * surrounding-suburb membership are absent from RSS, so those queries retain source-side filtering
 * and the shared six-hour selection cache. Cold product misses use bounded parallelism and the
 * existing D1 lease; failure rejects the whole response while preserving good product snapshots.
 */
export async function loadCatalogue(
    db: D1Database | undefined,
    base: string,
    query: FeedQuery,
    options: Parameters<typeof loadCachedSnapshot>[3] = {},
): Promise<CachedSnapshot> {
    if (!query.catalogue) return loadCachedSnapshot(db, base, query, options);
    const snapshots: CachedSnapshot[] = [];
    let next = 0;
    let failure: unknown;
    const abort = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        abort.abort();
    }, options.timeoutMs ?? 8000);
    const signal = options.signal
        ? AbortSignal.any([options.signal, abort.signal])
        : abort.signal;
    try {
        await Promise.all(
            Array.from(
                { length: Math.min(3, query.products.length) },
                async () => {
                    while (next < query.products.length && !signal.aborted) {
                        const product = query.products[next++];
                        const canonical = new URLSearchParams({
                            Day: query.sourceDate,
                            Product: String(product),
                        });
                        const upstream = new URLSearchParams({
                            Day: query.upstream[0].get("Day") ?? "today",
                            Product: String(product),
                        });
                        canonical.sort();
                        upstream.sort();
                        try {
                            snapshots.push(
                                await loadCachedSnapshot(
                                    db,
                                    base,
                                    {
                                        products: [product],
                                        sourceDate: query.sourceDate,
                                        canonical,
                                        upstream: [upstream],
                                    },
                                    { ...options, signal },
                                ),
                            );
                        } catch (error) {
                            failure ??= error;
                            abort.abort();
                        }
                    }
                },
            ),
        );
    } finally {
        clearTimeout(timeout);
    }
    if (timedOut)
        throw new ApiError(
            504,
            "upstream_timeout",
            "FuelWatch did not respond within the time limit.",
        );
    if (failure) throw failure;
    if (signal.aborted || snapshots.length !== query.products.length)
        throw new ApiError(
            504,
            "upstream_timeout",
            "FuelWatch selection was interrupted.",
        );

    const selectedBrands = query.canonical
        .get("Brand")
        ?.split(",")
        .map((code) => normalized(brands[Number(code) as BrandCode]));
    const selectedSuburbs = query.canonical
        .get("Suburb")
        ?.split(",")
        .map(normalized);
    const allItems = snapshots.flatMap(({ feed }) => feed.items);
    if (allItems.length > 10_000)
        throw new ApiError(
            502,
            "response_too_large",
            "Combined FuelWatch response contains too many quotes.",
        );
    const items: ProductQuote[] = allItems.filter(
        (item) =>
            (!selectedBrands ||
                selectedBrands.includes(normalized(item.brand))) &&
            (!selectedSuburbs ||
                selectedSuburbs.includes(normalized(item.location))),
    );
    items.sort(
        (a, b) =>
            a.product - b.product ||
            Number(a.price) - Number(b.price) ||
            a.address.localeCompare(b.address) ||
            a.location.localeCompare(b.location),
    );
    return {
        feed: { title: "FuelWatch prices", items },
        fetchedAt: Math.min(...snapshots.map((snapshot) => snapshot.fetchedAt)),
        expiresAt: Math.min(...snapshots.map((snapshot) => snapshot.expiresAt)),
        upstreamRequests: snapshots.reduce(
            (total, snapshot) => total + snapshot.upstreamRequests,
            0,
        ),
        cacheStatus: snapshots.some(
            (snapshot) => snapshot.cacheStatus === "BYPASS",
        )
            ? "BYPASS"
            : snapshots.some((snapshot) => snapshot.cacheStatus === "MISS")
              ? "MISS"
              : "HIT",
    };
}
