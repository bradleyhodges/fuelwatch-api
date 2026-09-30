import { BRAND_ASSET_PATH, brandAsset } from "./assets";
import {
    cacheKey,
    cacheTtl,
    enrichmentTtl,
    readCache,
    writeCache,
} from "./cache";
import { loadCatalogue } from "./catalogue";
import { readEnrichments, refreshEnrichment } from "./enrichment";
import { ApiError } from "./errors";
import { metadata } from "./feed";
import { ALLOWED_METHODS, corsHeaders, handleOptions } from "./httpOptions";
import {
    JSON_API_MEDIA_TYPE,
    jsonApiDocument,
    jsonApiError,
    validateJsonApiHeaders,
} from "./jsonapi";
import { parseQuery, perthTimestamp } from "./query";
import { parseExpansion } from "./references";
import { pruneSnapshots } from "./snapshot-cache";
import { normalisePhone } from "./station";
import { HOURLY_CRON, warmSnapshots } from "./warm";

/** Apply conditional/HEAD semantics and expose only the remaining shared-cache lifetime. */
function deliver(
    response: Response,
    request: Request,
    cacheStatus: string,
): Response {
    const headers = new Headers(response.headers);
    headers.set("X-FuelWatch-Cache", cacheStatus);
    const expires = Number(headers.get("X-FuelWatch-Fresh-Until"));
    headers.delete("X-FuelWatch-Fresh-Until");
    headers.set(
        "Cache-Control",
        Number.isFinite(expires) && expires > Date.now()
            ? `public, max-age=0, s-maxage=${Math.max(0, Math.floor((expires - Date.now()) / 1000))}`
            : "no-store",
    );
    const etag = headers.get("ETag");
    const matches = request.headers
        .get("If-None-Match")
        ?.split(",")
        .some(
            (tag) =>
                tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag,
        );
    if (matches || request.method === "HEAD") {
        void response.body?.cancel().catch(() => {});
        return new Response(null, {
            status: matches ? 304 : response.status,
            headers,
        });
    }
    return new Response(response.body, { status: response.status, headers });
}

export default {
    /** Independent schedules keep price warming active even when Google enrichment is disabled. */
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
        await pruneSnapshots(env.FUELWATCH_DB);
        if (controller.cron === HOURLY_CRON) {
            await warmSnapshots(env, controller.scheduledTime);
            return;
        }
        await refreshEnrichment(env);
    },
    /** Validate the complete upstream snapshot before publishing either public representation. */
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<Response> {
        const started = Date.now();
        const legacy = new URL(request.url).pathname === "/legacy";
        try {
            const url = new URL(request.url);
            const asset = BRAND_ASSET_PATH.test(url.pathname);
            if (
                url.pathname !== "/v1" &&
                url.pathname !== "/legacy" &&
                url.pathname !== "/" &&
                !asset
            )
                throw new ApiError(404, "not_found", "Endpoint not found.");

            if (request.method === "OPTIONS") return handleOptions(request);
            if (request.method !== "GET" && request.method !== "HEAD")
                throw new ApiError(
                    405,
                    "method_not_allowed",
                    "Use GET or HEAD to request prices.",
                );
            if (asset) return await brandAsset(request, env);
            // Keep shorthand URLs usable in browsers, including CORS preflights and HEAD.
            if (url.pathname === "/") {
                url.pathname = "/v1";
                return new Response(null, {
                    status: 302,
                    headers: {
                        ...corsHeaders,
                        Location: url.toString(),
                        "Cache-Control": "no-store",
                    },
                });
            }
            if (!legacy) validateJsonApiHeaders(request.headers);
            const representation = legacy
                ? { filters: url.searchParams, expand: [] }
                : parseExpansion(url.searchParams);
            const query = parseQuery(
                representation.filters,
                started,
                legacy ? "legacy" : "catalogue",
            );
            const key = cacheKey(url, query, representation.expand);
            const cached = await readCache(caches.default, key, started);
            if (cached) return deliver(cached, request, "HIT");
            const snapshot = await loadCatalogue(
                env.FUELWATCH_DB,
                env.FUELWATCH_URL,
                query,
                {
                    signal: request.signal,
                },
            );
            const { feed } = snapshot;
            const multipleProducts = query.products.length > 1;
            const enrichment =
                url.pathname === "/v1"
                    ? await readEnrichments(env.FUELWATCH_DB, feed.items)
                    : undefined;
            const now = Date.now();
            const info = metadata(query, feed.items.length, now);
            info.fetchedAt = perthTimestamp(snapshot.fetchedAt);
            // A request started just before a rollover cannot cache into the next period.
            const ttl = Math.min(
                Math.max(0, Math.floor((snapshot.expiresAt - now) / 1000)),
                enrichmentTtl(enrichment?.values() ?? [], now),
                cacheTtl(info, now),
                Math.max(
                    0,
                    cacheTtl(info, started) - Math.ceil((now - started) / 1000),
                ),
            );
            const body = JSON.stringify(
                url.pathname === "/v1"
                    ? await jsonApiDocument(
                          feed,
                          info,
                          enrichment,
                          now,
                          representation.expand,
                      )
                    : {
                          feed: {
                              ...feed,
                              items: feed.items.map(({ product, ...item }) => ({
                                  ...item,
                                  phone: normalisePhone(item.phone),
                                  ...(multipleProducts ? { product } : {}),
                              })),
                          },
                      },
            );
            const hash = await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(body),
            );
            const etag = `"${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
            const response = new Response(body, {
                headers: {
                    ...corsHeaders,
                    "Content-Type": legacy
                        ? "application/json;charset=UTF-8"
                        : JSON_API_MEDIA_TYPE,
                    ...(!legacy ? { Vary: "Accept" } : {}),
                    "X-Content-Type-Options": "nosniff",
                    "Cache-Control":
                        ttl > 0
                            ? `public, max-age=0, s-maxage=${ttl}`
                            : "no-store",
                    "X-FuelWatch-Fresh-Until": String(now + ttl * 1000),
                    "X-FuelWatch-Source-Date": info.sourceDate,
                    "X-FuelWatch-Fetched-At": info.fetchedAt,
                    "X-FuelWatch-Snapshot-Cache": snapshot.cacheStatus,
                    ETag: etag,
                },
            });
            if (ttl > 0)
                ctx.waitUntil(
                    writeCache(caches.default, key, response.clone()),
                );
            console.log({
                event: "feed_response",
                products: query.products,
                snapshotCache: snapshot.cacheStatus,
                upstreamRequests: snapshot.upstreamRequests,
                sourceDate: query.sourceDate,
                stations: feed.items.length,
                durationMs: now - started,
                ttl,
            });
            return deliver(response, request, "MISS");
        } catch (error) {
            console.error(error);
            const failure =
                error instanceof ApiError
                    ? error
                    : new ApiError(
                          500,
                          "internal_error",
                          "The price service could not complete the request.",
                      );
            console.warn({
                event: "request_failed",
                code: failure.code,
                status: failure.status,
                durationMs: Date.now() - started,
            });
            const headers = new Headers({
                ...corsHeaders,
                "Content-Type": legacy
                    ? "application/json;charset=UTF-8"
                    : JSON_API_MEDIA_TYPE,
                ...(!legacy ? { Vary: "Accept" } : {}),
                "Cache-Control": "no-store",
            });
            if (failure.status === 405) headers.set("Allow", ALLOWED_METHODS);
            if (failure.retryAfter !== undefined)
                headers.set("Retry-After", String(failure.retryAfter));
            return new Response(
                request.method === "HEAD"
                    ? null
                    : JSON.stringify(
                          legacy
                              ? {
                                    error: {
                                        code: failure.code,
                                        message: failure.message,
                                    },
                                }
                              : jsonApiError(failure),
                      ),
                { status: failure.status, headers },
            );
        }
    },
} satisfies ExportedHandler<Env>;
