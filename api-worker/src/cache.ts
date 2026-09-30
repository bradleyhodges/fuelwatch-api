import type { FeedMetadata } from "./feed";
import { type FeedQuery, perthDate, shiftDate } from "./query";
import type { ExpandableField } from "./references";
import type { StationEnrichment } from "./station";

/**
 * Limit edge freshness at provider refresh and retention boundaries.
 * @param profiles Profiles read for this snapshot; no credentials or prices are present.
 * @param now Response construction time in milliseconds.
 * @returns Whole seconds until the earliest transition, or Infinity when there is no enrichment.
 * @remarks Otherwise an edge hit could bypass D1's age check or keep a stale:false flag after expiry.
 */
export function enrichmentTtl(
    profiles: Iterable<StationEnrichment>,
    now: number,
): number {
    let deadline = Infinity;
    for (const profile of profiles) {
        const refresh = Date.parse(profile.expiresAt);
        deadline = Math.min(
            deadline,
            Date.parse(profile.fetchedAt) + 30 * 86400_000,
            refresh > now ? refresh : Infinity,
        );
    }
    return Math.max(0, Math.floor((deadline - now) / 1000));
}

/** Published snapshots are reusable for six hours; empty results must not hide publication. */
export const PUBLISHED_TTL_SECONDS = 6 * 60 * 60;

/** Bound public cache freshness at relative-day rollover, price expiry and pending publication. */
export function cacheTtl(info: FeedMetadata, now: number): number {
    const today = perthDate(now);
    const boundaries = [
        `${shiftDate(today, 1)}T00:00:00+08:00`,
        ...(info.publicationStatus === "available"
            ? []
            : [`${today}T14:30:00+08:00`]),
    ]
        .map(Date.parse)
        .filter((time) => time > now);
    const expiry = Math.min(...boundaries, Date.parse(info.validUntil));
    const maximum =
        info.publicationStatus === "available" ? PUBLISHED_TTL_SECONDS : 30;
    return Math.max(0, Math.min(maximum, Math.floor((expiry - now) / 1000)));
}

/** Cache identity contains no client headers, ignored filters or relative dates. */
export function cacheKey(
    request: URL,
    query: FeedQuery,
    expand: readonly ExpandableField[] = [],
): Request {
    const url = new URL(
        `/__fuelwatch_cache/service-station-codes-v1/${request.pathname === "/legacy" ? "legacy" : "compact"}`,
        request.origin,
    );
    url.search = query.canonical.toString();
    if (expand.length)
        url.searchParams.set("Expand", [...new Set(expand)].sort().join(","));
    return new Request(url, { method: "GET" });
}

/** Cache availability is an optimization, never a data-availability dependency. */
export async function readCache(
    cache: Cache,
    key: Request,
    now: number,
): Promise<Response | undefined> {
    try {
        const response = await cache.match(key);
        if (!response) return undefined;
        const expiry = Number(response.headers.get("X-FuelWatch-Fresh-Until"));
        if (!Number.isFinite(expiry) || expiry <= Math.max(now, Date.now())) {
            void response.body?.cancel().catch(() => {});
            return undefined;
        }
        return response;
    } catch {
        console.warn({ event: "cache_read_failed" });
        return undefined;
    }
}

/** Attach to waitUntil; cache failures are observable and contained. */
export async function writeCache(
    cache: Cache,
    key: Request,
    response: Response,
): Promise<void> {
    try {
        await cache.put(key, response);
    } catch {
        console.warn({ event: "cache_write_failed" });
    }
}
