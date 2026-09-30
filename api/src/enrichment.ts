import { parseFeed } from "./feed";
import { FUELWATCH_PRODUCTS, type FuelWatchRssItem } from "./fuelwatch";
import { GoogleLookupError, lookupPlace, type StationSeed } from "./google";
import { parseQuery, upstreamUrl } from "./query";
import {
    FEATURES,
    type Feature,
    type OpeningHours,
    type StationEnrichment,
    stationKey,
    validHours,
    WEEKDAYS,
} from "./station";
import { type Fetcher, fetchFeed } from "./upstream";

const DAY = 86_400_000;
interface CachedRow {
    station_key: string;
    seed_json: string;
    enrichment_json: string | null;
}
interface DueRow extends CachedRow {
    place_id: string | null;
    failure_count: number;
}
type RefreshEnv = Pick<
    Env,
    | "FUELWATCH_DB"
    | "FUELWATCH_URL"
    | "GOOGLE_MAPS_API_KEY"
    | "GOOGLE_DAILY_REQUEST_LIMIT"
    | "ENRICHMENT_BATCH_SIZE"
    | "ENRICHMENT_REFRESH_DAYS"
>;

/** Extract only station identity into D1; daily prices never live in the enrichment database. */
function seed(item: FuelWatchRssItem): StationSeed {
    return {
        name: item["trading-name"],
        brand: item.brand,
        street: item.address,
        suburb: item.location,
        latitude: Number(item.latitude),
        longitude: Number(item.longitude),
    };
}

/** Parse operational settings strictly so a typo cannot accidentally remove spending limits. */
function setting(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    if (value === undefined) return fallback;
    if (
        !/^\d+$/.test(value) ||
        Number(value) < minimum ||
        Number(value) > maximum
    )
        throw new Error("Invalid enrichment configuration");
    return Number(value);
}

/**
 * Validate persistent JSON at the trust boundary, including display strings and allowed vocabulary.
 * @param json Stored enrichment_json; may come from an older deployment or manual database edits.
 * @returns A newly projected profile, or undefined when the record cannot safely be served.
 */
export function cachedEnrichment(json: string): StationEnrichment | undefined {
    try {
        if (json.length > 16_000) return undefined;
        const data: unknown = JSON.parse(json);
        if (!data || typeof data !== "object" || Array.isArray(data))
            return undefined;
        const value = data as Record<string, unknown>;
        const text = (input: unknown, limit = 200): input is string =>
            typeof input === "string" && input.length <= limit;
        if (
            !text(value.placeId) ||
            !/^[\w-]+$/.test(value.placeId) ||
            !text(value.fetchedAt, 64) ||
            !Number.isFinite(Date.parse(value.fetchedAt)) ||
            !text(value.expiresAt, 64) ||
            !Number.isFinite(Date.parse(value.expiresAt)) ||
            Date.parse(value.expiresAt) <= Date.parse(value.fetchedAt) ||
            !(
                value.postcode === null ||
                (text(value.postcode, 4) && /^\d{4}$/.test(value.postcode))
            ) ||
            !(
                value.phone === null ||
                (text(value.phone, 16) && /^\+[1-9]\d{6,14}$/.test(value.phone))
            ) ||
            ![true, false, null].includes(value.is24Hours as boolean | null) ||
            !Array.isArray(value.features) ||
            value.features.length > FEATURES.length ||
            !value.features.every((feature) =>
                FEATURES.includes(feature as Feature),
            ) ||
            !text(value.googleMapsUri, 2000) ||
            !value.googleMapsUri.startsWith("https://www.google.com/maps/") ||
            !value.hours ||
            typeof value.hours !== "object" ||
            Array.isArray(value.hours) ||
            !Array.isArray(value.attributions) ||
            value.attributions.length > 10
        )
            return undefined;
        const hours: OpeningHours = {};
        for (const [day, times] of Object.entries(value.hours)) {
            const weekday = WEEKDAYS.find((value) => value === day);
            if (!weekday || !text(times, 150) || !validHours(times))
                return undefined;
            hours[weekday] = times;
        }
        const attributions: StationEnrichment["attributions"] = [];
        for (const raw of value.attributions) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
                return undefined;
            const attribution = raw as Record<string, unknown>;
            if (
                !text(attribution.displayName) ||
                !text(attribution.uri, 2000) ||
                !/^https:\/\//.test(attribution.uri)
            )
                return undefined;
            attributions.push({
                displayName: attribution.displayName,
                uri: attribution.uri,
            });
        }
        return {
            placeId: value.placeId,
            fetchedAt: value.fetchedAt,
            expiresAt: value.expiresAt,
            postcode: value.postcode,
            phone: value.phone,
            features: value.features as Feature[],
            hours,
            is24Hours: value.is24Hours as boolean | null,
            googleMapsUri: value.googleMapsUri,
            attributions,
        };
    } catch {
        return undefined;
    }
}

/**
 * Read requested station records using indexed, bounded D1 queries. Never calls Google or writes to D1.
 * @param db Optional production/local binding. An absent binding leaves prices usable.
 * @param items Fully validated FuelWatch records; their complete matching fingerprint must still agree.
 * @param now Millisecond clock used to reject future or overly old profiles.
 * @returns Valid cached records; failures/timeouts degrade to FuelWatch-only output.
 * @remarks The 1.5-second budget includes every batch. A timed-out query may finish at D1, but no further batches start.
 */
export async function readEnrichments(
    db: D1Database | undefined,
    items: FuelWatchRssItem[],
    now = Date.now(),
): Promise<Map<string, StationEnrichment>> {
    const result = new Map<string, StationEnrichment>();
    if (!db || !items.length) return result;
    const expected = new Map(
        items.map((item) => [stationKey(item), JSON.stringify(seed(item))]),
    );
    const keys = [...expected.keys()];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("D1 read deadline")), 1500);
    });
    try {
        for (let i = 0; i < keys.length; i += 80) {
            const batch = keys.slice(i, i + 80);
            const rows = await Promise.race([
                db
                    .prepare(
                        `SELECT station_key, seed_json, enrichment_json FROM station_enrichment WHERE station_key IN (${batch.map(() => "?").join(",")}) AND enrichment_json IS NOT NULL`,
                    )
                    .bind(...batch)
                    .all<CachedRow>(),
                timeout,
            ]);
            for (const row of rows.results) {
                if (
                    !row.enrichment_json ||
                    row.seed_json !== expected.get(row.station_key)
                )
                    continue;
                const value = cachedEnrichment(row.enrichment_json);
                if (
                    value &&
                    Date.parse(value.fetchedAt) <= now &&
                    now - Date.parse(value.fetchedAt) < 30 * DAY
                )
                    result.set(row.station_key, value);
            }
        }
    } catch {
        console.warn({ event: "enrichment_cache_read_failed" });
    } finally {
        clearTimeout(timer);
    }
    return result;
}

/**
 * Atomically reserve a paid request against the UTC day's limit, including failures and timeouts.
 * @param db Shared D1 database; the unique date key makes concurrent reservations atomic.
 * @param now Millisecond timestamp used to choose the UTC accounting day.
 * @param limit Validated nonnegative request limit, never a currency amount.
 * @throws GoogleLookupError with budget_exhausted before any network request when the cap is reached.
 */
export async function reserveGoogleRequest(
    db: D1Database,
    now: number,
    limit: number,
): Promise<void> {
    if (limit === 0) throw new GoogleLookupError("budget_exhausted");
    const reserved = await db
        .prepare(`INSERT INTO google_request_budget(utc_day, requests) VALUES (?, 1)
        ON CONFLICT(utc_day) DO UPDATE SET requests = requests + 1 WHERE requests < ? RETURNING requests`)
        .bind(new Date(now).toISOString().slice(0, 10), limit)
        .first<{ requests: number }>();
    if (!reserved) throw new GoogleLookupError("budget_exhausted");
}

/** Apply a result only while this invocation owns the lease; false means no row was written. */
async function saveResult(
    db: D1Database,
    owner: string,
    key: string,
    value: StationEnrichment | null,
    nextAttempt: number,
    failures: number,
    now: number,
    keepExisting = false,
): Promise<boolean> {
    const result = await db
        .prepare(`UPDATE station_enrichment SET next_attempt_at = ?, failure_count = ?,
        place_id = CASE WHEN ? THEN place_id ELSE ? END,
        enrichment_json = CASE WHEN ? THEN enrichment_json ELSE ? END
        WHERE station_key = ? AND EXISTS (SELECT 1 FROM enrichment_refresh WHERE id = 1 AND owner = ? AND lease_until > ?)`)
        .bind(
            nextAttempt,
            failures,
            keepExisting ? 1 : 0,
            value?.placeId ?? null,
            keepExisting ? 1 : 0,
            value ? JSON.stringify(value) : null,
            key,
            owner,
            now,
        )
        .run();
    return result.meta.changes === 1;
}

/**
 * Discover one fuel product and refresh a bounded batch under a database lease.
 * @param env Generated Worker bindings; optional absence is handled for development/failure recovery.
 * @param options Test overrides for the clock origin and HTTP transport. Production uses wall time and fetch.
 * @throws Error for invalid configuration or D1 write failures so scheduled observability records failure.
 * @remarks HTTP requests never invoke this. Cron rotates through all products, so diesel-only sites are discovered too.
 * Failed matches wait a day; provider failures use backoff. 403/configuration and 429 errors pause all enrichment.
 * A seven-day default freshness interval and persistent place IDs avoid repeating daily discovery charges.
 */
export async function refreshEnrichment(
    env: RefreshEnv,
    options: { now?: number; fetcher?: Fetcher } = {},
): Promise<void> {
    const db = env.FUELWATCH_DB;
    if (!db || !env.GOOGLE_MAPS_API_KEY) {
        console.warn({ event: "enrichment_not_configured" });
        return;
    }
    const limit = setting(env.GOOGLE_DAILY_REQUEST_LIMIT, 100, 0, 10_000);
    const batchSize = setting(env.ENRICHMENT_BATCH_SIZE, 10, 1, 500);
    const days = setting(env.ENRICHMENT_REFRESH_DAYS, 7, 1, 30);
    if (limit === 0) return;
    const started = Date.now();
    const clock = () => (options.now ?? started) + Date.now() - started;
    const owner = crypto.randomUUID();
    const lock = await db
        .prepare(
            "UPDATE enrichment_refresh SET owner = ?, lease_until = ? WHERE id = 1 AND lease_until <= ? AND blocked_until <= ?",
        )
        .bind(owner, clock() + 120_000, clock(), clock())
        .run();
    if (lock.meta.changes !== 1) return;
    const counts = {
        matched: 0,
        unmatched: 0,
        failed: 0,
        writeSkipped: 0,
        requestsReserved: 0,
    };
    let stopReason:
        | "complete"
        | "time_limit"
        | "budget_exhausted"
        | "provider_cooldown"
        | "lease_lost" = "complete";
    try {
        const state = await db
            .prepare("SELECT next_product FROM enrichment_refresh WHERE id = 1")
            .first<{ next_product: number }>();
        const products = Object.keys(FUELWATCH_PRODUCTS);
        const product = products[(state?.next_product ?? 0) % products.length];
        const query = parseQuery(
            new URLSearchParams({ Product: product, Day: "today" }),
            clock(),
        );
        const xml = await fetchFeed(
            upstreamUrl(env.FUELWATCH_URL, query.upstream[0]),
            {
                fetcher: options.fetcher,
            },
        );
        const feed = await parseFeed(xml, query.sourceDate);
        // Bound transaction size, fence delayed jobs, and touch unchanged identities only once a day.
        for (let i = 0; i < feed.items.length; i += 50) {
            if (Date.now() - started > 60_000) {
                stopReason = "time_limit";
                break;
            }
            await db.batch(
                feed.items.slice(i, i + 50).map((item) =>
                    db
                        .prepare(`INSERT INTO station_enrichment(station_key, seed_json, last_seen_at)
                SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM enrichment_refresh WHERE id = 1 AND owner = ? AND lease_until > ?)
                ON CONFLICT(station_key) DO UPDATE SET seed_json = excluded.seed_json, last_seen_at = excluded.last_seen_at,
                next_attempt_at = CASE WHEN seed_json <> excluded.seed_json THEN 0 ELSE next_attempt_at END,
                place_id = CASE WHEN seed_json <> excluded.seed_json THEN NULL ELSE place_id END,
                enrichment_json = CASE WHEN seed_json <> excluded.seed_json THEN NULL ELSE enrichment_json END,
                failure_count = CASE WHEN seed_json <> excluded.seed_json THEN 0 ELSE failure_count END
                WHERE seed_json <> excluded.seed_json OR last_seen_at < excluded.last_seen_at - 86400000`)
                        .bind(
                            stationKey(item),
                            JSON.stringify(seed(item)),
                            clock(),
                            owner,
                            clock(),
                        ),
                ),
            );
        }
        await db
            .prepare(
                "UPDATE enrichment_refresh SET next_product = ? WHERE id = 1 AND owner = ?",
            )
            .bind(((state?.next_product ?? 0) + 1) % products.length, owner)
            .run();
        const due = await db
            .prepare(
                "SELECT station_key, seed_json, enrichment_json, place_id, failure_count FROM station_enrichment WHERE next_attempt_at <= ? AND last_seen_at > ? ORDER BY next_attempt_at, station_key LIMIT ?",
            )
            .bind(clock(), clock() - 30 * DAY, batchSize)
            .all<DueRow>();
        for (const row of due.results) {
            if (Date.now() - started > 60_000) {
                stopReason = "time_limit";
                break;
            }
            try {
                // seed_json is exclusively written above from validated FuelWatch data, never from client input.
                const source = JSON.parse(row.seed_json) as StationSeed;
                const value = await lookupPlace(
                    source,
                    env.GOOGLE_MAPS_API_KEY,
                    {
                        placeId: row.place_id ?? undefined,
                        now: clock(),
                        refreshDays: days,
                        fetcher: options.fetcher,
                        beforeRequest: async () => {
                            await reserveGoogleRequest(db, clock(), limit);
                            counts.requestsReserved++;
                        },
                    },
                );
                const saved = await saveResult(
                    db,
                    owner,
                    row.station_key,
                    value,
                    value ? Date.parse(value.expiresAt) : clock() + DAY,
                    0,
                    clock(),
                );
                if (!saved) {
                    counts.writeSkipped++;
                    stopReason = "lease_lost";
                    break;
                }
                if (value) counts.matched++;
                else counts.unmatched++;
            } catch (error) {
                const code =
                    error instanceof GoogleLookupError ? error.code : "storage";
                console.warn({ event: "enrichment_lookup_failed", code });
                if (code === "storage") throw error;
                if (code === "budget_exhausted") {
                    stopReason = "budget_exhausted";
                    break;
                }
                counts.failed++;
                const failures = Math.min(row.failure_count + 1, 10);
                const saved = await saveResult(
                    db,
                    owner,
                    row.station_key,
                    null,
                    clock() + Math.min(DAY, 3600_000 * 2 ** (failures - 1)),
                    failures,
                    clock(),
                    true,
                );
                if (!saved) {
                    counts.writeSkipped++;
                    stopReason = "lease_lost";
                    break;
                }
                if (code === "configuration" || code === "rate_limited") {
                    stopReason = "provider_cooldown";
                    await db
                        .prepare(
                            "UPDATE enrichment_refresh SET blocked_until = ? WHERE id = 1 AND owner = ?",
                        )
                        .bind(
                            clock() +
                                (code === "configuration" ? DAY : 3600_000),
                            owner,
                        )
                        .run();
                    break;
                }
            }
        }
        await db.batch([
            db
                .prepare(
                    "DELETE FROM station_enrichment WHERE last_seen_at < ?",
                )
                .bind(clock() - 90 * DAY),
            db
                .prepare("DELETE FROM google_request_budget WHERE utc_day < ?")
                .bind(new Date(clock() - 35 * DAY).toISOString().slice(0, 10)),
        ]);
        // Per-run matches are different from feed size and total backlog; expose all three explicitly.
        const cache = await db
            .prepare(`SELECT COUNT(*) AS stations,
            COUNT(enrichment_json) AS enriched,
            COALESCE(SUM(enrichment_json IS NULL AND next_attempt_at = 0), 0) AS pending
            FROM station_enrichment`)
            .first<{ stations: number; enriched: number; pending: number }>();
        console.log({
            event: "enrichment_refreshed",
            product,
            discovered: feed.items.length,
            ...counts,
            stopReason,
            cache,
            durationMs: Date.now() - started,
        });
    } finally {
        // Conditional release cannot unlock a successor if this invocation exceeded its lease.
        await db
            .prepare(
                "UPDATE enrichment_refresh SET owner = NULL, lease_until = 0 WHERE id = 1 AND owner = ?",
            )
            .bind(owner)
            .run();
    }
}
