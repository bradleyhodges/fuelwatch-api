export const ALLOWED_METHODS = "GET, HEAD, OPTIONS";
export const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Expose-Headers":
        "ETag, Retry-After, X-FuelWatch-Cache, X-FuelWatch-Snapshot-Cache, X-FuelWatch-Source-Date, X-FuelWatch-Fetched-At",
};

/** Access-Control-Request-Headers is optional on a valid browser preflight. */
export function handleOptions(request: Request): Response {
    const method = request.headers.get("Access-Control-Request-Method");
    const headers = new Headers({
        ...corsHeaders,
        Allow: ALLOWED_METHODS,
        "Cache-Control": "no-store",
    });
    if (method && !["GET", "HEAD", "OPTIONS"].includes(method))
        return new Response(null, { status: 405, headers });
    headers.set("Access-Control-Max-Age", "86400");
    const requestedHeaders = request.headers.get(
        "Access-Control-Request-Headers",
    );
    if (requestedHeaders) {
        headers.set("Access-Control-Allow-Headers", requestedHeaders);
        headers.set("Vary", "Access-Control-Request-Headers");
    }
    return new Response(null, { status: 204, headers });
}
