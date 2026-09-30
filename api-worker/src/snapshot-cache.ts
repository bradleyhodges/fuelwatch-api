import { cacheTtl, PUBLISHED_TTL_SECONDS } from "./cache";
import { ApiError } from "./errors";
import { metadata } from "./feed";
import { type FeedQuery, upstreamUrl } from "./query";
import { loadSnapshot, type ProductFeed } from "./snapshot";

const LEASE_MS = 60_000;
const CHUNK_BYTES = 1_000_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const DATABASE_TIMEOUT_MS = 2000;

/** Origin provenance is retained on a cache hit; reads never renew the six-hour lifetime. */
export interface CachedSnapshot {
    feed: ProductFeed;
    fetchedAt: number;
    expiresAt: number;
    cacheStatus: "HIT" | "MISS" | "BYPASS";
    /** Actual origin calls made during this load, including retries; zero on D1 hits. */
    upstreamRequests: number;
}
interface CacheChunk {
    fetched_at: number;
    expires_at: number;
    chunk_count: number;
    chunk_index: number;
    payload: number[] | null;
}

/** Bound D1 latency. SQL owner checks fence writes that finish after their caller times out. */
async function database<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error("D1 cache timeout")),
                    DATABASE_TIMEOUT_MS,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** Use the configured upstream and absolute selection, independent of client host or representation. */
async function snapshotKey(base: string, query: FeedQuery): Promise<string> {
    const url = upstreamUrl(base, query.canonical);
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`snapshot-v1:${url}`),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
    ).join("");
}

/** Read all chunks in one primary-database query so a concurrent replacement cannot mix versions. */
async function readSnapshot(
    db: D1Database,
    key: string,
    now: number,
): Promise<CachedSnapshot | undefined> {
    const { results } = await database(
        db
            .prepare(`
        SELECT f.fetched_at, f.expires_at, f.chunk_count, c.chunk_index, c.payload
        FROM feed_cache f LEFT JOIN feed_cache_chunks c ON c.cache_key = f.cache_key
        WHERE f.cache_key = ? AND f.expires_at > ? ORDER BY c.chunk_index
    `)
            .bind(key, now)
            .all<CacheChunk>(),
    );
    if (!results.length) return undefined;
    const first = results[0];
    try {
        if (
            first.chunk_count !== results.length ||
            first.fetched_at > now ||
            first.expires_at - first.fetched_at >
                PUBLISHED_TTL_SECONDS * 1000 ||
            results.some(
                (row, index) =>
                    row.chunk_index !== index || row.payload === null,
            )
        )
            throw new Error("Invalid cache chunks");
        const compressed = new Blob(
            results.map((row) => new Uint8Array(row.payload ?? [])),
        );
        const reader = compressed
            .stream()
            .pipeThrough(new DecompressionStream("gzip"))
            .getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > MAX_BODY_BYTES)
                    throw new Error("Oversized cached snapshot");
                chunks.push(value);
            }
        } finally {
            await reader.cancel().catch(() => {});
        }
        // Only this worker writes these versioned, validated snapshots. Check the container as well
        // as chunk completeness so corrupt storage is never returned as a successful empty result.
        const feed = JSON.parse(await new Blob(chunks).text()) as ProductFeed;
        if (!feed || !Array.isArray(feed.items))
            throw new Error("Invalid cached snapshot");
        return {
            feed,
            fetchedAt: first.fetched_at,
            expiresAt: first.expires_at,
            cacheStatus: "HIT",
            upstreamRequests: 0,
        };
    } catch {
        console.warn({ event: "snapshot_cache_corrupt" });
        await database(
            db
                .prepare(
                    "DELETE FROM feed_cache WHERE cache_key = ? AND expires_at = ? AND owner IS NULL",
                )
                .bind(key, first.expires_at)
                .run(),
        );
        return undefined;
    }
}

/**
 * Reuse a published FuelWatch snapshot globally for six hours without renewing it on reads.
 * @param db Existing D1 binding; an unavailable cache degrades to bounded origin fetching.
 * @param base Operator-controlled FuelWatch origin; included in cache identity.
 * @param query Validated filters with an absolute source date.
 * @param options Origin transport, clock and bounded lock wait are injectable for regression tests.
 * @remarks Ordinary D1 binding queries use the primary. A conditional SQL lease coordinates
 * isolates/data centers; losers wait briefly or receive Retry-After instead of duplicating traffic.
 * Only complete validated feeds are committed, with chunk replacement in one transaction.
 */
export async function loadCachedSnapshot(
    db: D1Database | undefined,
    base: string,
    query: FeedQuery,
    options: Parameters<typeof loadSnapshot>[2] & {
        clock?: () => number;
        waitMs?: number;
        /** Scheduled refresh cutoff; public callers omit this and use the normal six-hour lifetime. */
        refreshBefore?: number;
    } = {},
): Promise<CachedSnapshot> {
    const clock = options.clock ?? Date.now;
    const fetchSnapshot = async (): Promise<CachedSnapshot> => {
        let upstreamRequests = 0;
        const fetcher = options.fetcher ?? fetch;
        const feed = await loadSnapshot(base, query, {
            ...options,
            fetcher: (url, init) => {
                upstreamRequests++;
                return fetcher(url, init);
            },
        });
        const fetchedAt = clock();
        const info = metadata(query, feed.items.length, fetchedAt);
        // One fuel can be published before another. Do not hide the missing product for six hours.
        const publishedProducts = new Set(
            feed.items.map((item) => item.product),
        );
        const complete = query.products.every((product) =>
            publishedProducts.has(product),
        );
        const ttl = complete
            ? PUBLISHED_TTL_SECONDS
            : Math.min(30, cacheTtl(info, fetchedAt));
        return {
            feed,
            fetchedAt,
            expiresAt: fetchedAt + ttl * 1000,
            cacheStatus: "BYPASS",
            upstreamRequests,
        };
    };
    if (!db) return fetchSnapshot();
    const key = await snapshotKey(base, query);
    const owner = crypto.randomUUID();
    const deadline = Date.now() + (options.waitMs ?? 10_000);
    let attempt = 0;
    let previous: CachedSnapshot | undefined;
    try {
        for (;;) {
            options.signal?.throwIfAborted();
            const cached = await readSnapshot(db, key, clock());
            if (cached && cached.expiresAt > clock()) {
                if (cached.fetchedAt >= (options.refreshBefore ?? 0))
                    return cached;
                previous = cached;
            }
            const now = clock();
            const claimed = await database(
                db
                    .prepare(`
                INSERT INTO feed_cache(cache_key, owner, lease_until) VALUES (?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET owner = excluded.owner, lease_until = excluded.lease_until
                WHERE (feed_cache.expires_at <= ? OR feed_cache.fetched_at < ?) AND feed_cache.lease_until <= ?
                RETURNING cache_key
            `)
                    .bind(
                        key,
                        owner,
                        now + LEASE_MS,
                        now,
                        options.refreshBefore ?? 0,
                        now,
                    )
                    .first(),
            );
            if (claimed) break;
            if (Date.now() >= deadline)
                throw new ApiError(
                    503,
                    "cache_refresh_busy",
                    "This price snapshot is being refreshed. Please retry shortly.",
                    2,
                );
            await new Promise((resolve) =>
                setTimeout(
                    resolve,
                    Math.min(
                        250 * 2 ** attempt++,
                        2000,
                        Math.max(0, deadline - Date.now()),
                    ),
                ),
            );
        }
    } catch (error) {
        if (error instanceof ApiError || options.signal?.aborted) throw error;
        console.warn({
            event: "snapshot_cache_unavailable",
            operation: "read_or_lock",
        });
        return fetchSnapshot();
    }
    try {
        const snapshot = await fetchSnapshot();
        // A transient empty response must not erase this period's already published prices.
        // Keep the previous expiry unchanged: refresh failures never make old data fresh again.
        if (
            options.refreshBefore &&
            previous?.feed.items.length &&
            !snapshot.feed.items.length
        ) {
            throw new ApiError(
                502,
                "invalid_feed",
                "FuelWatch returned an empty replacement for published prices.",
            );
        }
        try {
            const body = new TextEncoder().encode(
                JSON.stringify(snapshot.feed),
            );
            if (body.byteLength > MAX_BODY_BYTES)
                throw new Error("Snapshot exceeds cache capacity");
            const compressed = new Uint8Array(
                await new Response(
                    new Blob([body])
                        .stream()
                        .pipeThrough(new CompressionStream("gzip")),
                ).arrayBuffer(),
            );
            const chunks = Array.from(
                { length: Math.ceil(compressed.length / CHUNK_BYTES) },
                (_, index) =>
                    compressed.slice(
                        index * CHUNK_BYTES,
                        (index + 1) * CHUNK_BYTES,
                    ),
            );
            const now = clock();
            const guard =
                "SELECT 1 FROM feed_cache WHERE cache_key = ? AND owner = ? AND lease_until > ?";
            const writes = await database(
                db.batch([
                    db
                        .prepare(
                            `DELETE FROM feed_cache_chunks WHERE cache_key = ? AND EXISTS (${guard})`,
                        )
                        .bind(key, key, owner, now),
                    ...chunks.map((chunk, index) =>
                        db
                            .prepare(
                                `INSERT INTO feed_cache_chunks(cache_key, chunk_index, payload) SELECT ?, ?, ? WHERE EXISTS (${guard})`,
                            )
                            .bind(key, index, chunk.buffer, key, owner, now),
                    ),
                    db
                        .prepare(
                            "UPDATE feed_cache SET fetched_at = ?, expires_at = ?, chunk_count = ?, owner = NULL, lease_until = 0 WHERE cache_key = ? AND owner = ? AND lease_until > ?",
                        )
                        .bind(
                            snapshot.fetchedAt,
                            snapshot.expiresAt,
                            chunks.length,
                            key,
                            owner,
                            now,
                        ),
                ]),
            );
            if (writes[writes.length - 1].meta.changes !== 1)
                throw new ApiError(
                    503,
                    "cache_refresh_busy",
                    "This price snapshot is being refreshed. Please retry shortly.",
                    2,
                );
            snapshot.cacheStatus = "MISS";
        } catch (error) {
            if (error instanceof ApiError) throw error;
            // A storage failure must not trigger a second origin fetch or lose an already valid feed.
            console.warn({
                event: "snapshot_cache_unavailable",
                operation: "write",
            });
        }
        return snapshot;
    } finally {
        try {
            await database(
                db
                    .prepare(
                        "UPDATE feed_cache SET owner = NULL, lease_until = 0 WHERE cache_key = ? AND owner = ?",
                    )
                    .bind(key, owner)
                    .run(),
            );
        } catch {
            console.warn({
                event: "snapshot_cache_unavailable",
                operation: "release",
            });
        }
    }
}

/** Prune at most 100 expired selections per scheduled invocation; cascading deletes remove chunks. */
export async function pruneSnapshots(
    db: D1Database | undefined,
    now = Date.now(),
): Promise<void> {
    if (!db) return;
    try {
        await database(
            db
                .prepare(`DELETE FROM feed_cache WHERE cache_key IN (
            SELECT cache_key FROM feed_cache WHERE expires_at <= ? AND lease_until <= ? ORDER BY expires_at LIMIT 100
        )`)
                .bind(now, now)
                .run(),
        );
    } catch {
        console.warn({
            event: "snapshot_cache_unavailable",
            operation: "prune",
        });
    }
}
