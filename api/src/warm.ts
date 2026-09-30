import { FUELWATCH_PRODUCTS } from "./fuelwatch";
import {
    PERTH_OFFSET_MS,
    parseQuery,
    perthDate,
    perthTimestamp,
} from "./query";
import { loadCachedSnapshot } from "./snapshot-cache";
import type { Fetcher } from "./upstream";

export const HOURLY_CRON = "0 * * * *";

/**
 * Refresh the unfiltered single-product selections used by Home Assistant every hour.
 * @param env The same origin and D1 binding used by public requests; no Google credentials are used.
 * @param scheduledTime UTC epoch from the cron event, used to deduplicate delivery retries.
 * @param options Injectable clock and origin transport for deterministic publication-boundary tests.
 * @remarks Before 06:00 AWST the active period is yesterday; today's prices are already published.
 * After 14:30 include tomorrow. Failures are isolated per product/day, then fail the cron event so
 * operations can detect incomplete warming. Existing usable snapshots survive failed replacements.
 */
export async function warmSnapshots(
    env: Env,
    scheduledTime: number,
    options: { clock?: () => number; fetcher?: Fetcher } = {},
): Promise<void> {
    if (!env.FUELWATCH_DB)
        throw new Error("Hourly warming requires FUELWATCH_DB");
    const clock = options.clock ?? Date.now;
    const started = clock();
    const local = new Date(started + PERTH_OFFSET_MS);
    const days =
        local.getUTCHours() < 6
            ? ["yesterday", "today"]
            : local.getUTCHours() * 60 + local.getUTCMinutes() >= 14 * 60 + 30
              ? ["today", "tomorrow"]
              : ["today"];
    const selections = days.flatMap((Day) =>
        Object.keys(FUELWATCH_PRODUCTS).map((Product) => ({ Day, Product })),
    );
    let next = 0;
    let refreshed = 0;
    let reused = 0;
    let empty = 0;
    let failed = 0;
    // Bound cron traffic just like interactive multi-filter requests. All selections still get a turn.
    await Promise.all(
        Array.from({ length: 3 }, async () => {
            while (next < selections.length) {
                const selection = selections[next++];
                try {
                    // Do not let a delayed event relabel yesterday's relative selections after midnight.
                    if (perthDate(clock()) !== perthDate(started))
                        throw new Error("Price date changed during warming");
                    const query = parseQuery(
                        new URLSearchParams(selection),
                        started,
                    );
                    const snapshot = await loadCachedSnapshot(
                        env.FUELWATCH_DB,
                        env.FUELWATCH_URL,
                        query,
                        {
                            clock,
                            fetcher: options.fetcher,
                            refreshBefore: Math.min(scheduledTime, started),
                        },
                    );
                    if (snapshot.cacheStatus === "BYPASS")
                        throw new Error("Shared cache publication failed");
                    if (snapshot.cacheStatus === "MISS") refreshed++;
                    else reused++;
                    if (!snapshot.feed.items.length) empty++;
                } catch {
                    failed++;
                    console.warn({
                        event: "feed_warm_failed",
                        product: selection.Product,
                        day: selection.Day,
                    });
                }
            }
        }),
    );
    console.log({
        event: "feeds_warmed",
        scheduledAt: perthTimestamp(scheduledTime),
        refreshed,
        reused,
        empty,
        failed,
        durationMs: clock() - started,
    });
    if (failed)
        throw new Error(
            `Hourly FuelWatch refresh failed for ${failed} selections`,
        );
}
