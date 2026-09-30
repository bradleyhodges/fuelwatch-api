import assetHeaders from "./asset-headers.json";
import { ApiError } from "./errors";
import { corsHeaders } from "./httpOptions";

/** Only this public URL namespace exposes SVGs from the bundled brands directory. */
export const BRAND_ASSET_PATH = /^\/static\/image\/brand\/([a-z0-9_]+\.svg)$/;

/**
 * Handle logo requests that reach the script (normally missing files or non-GET methods).
 * Existing SVG GET/HEAD requests are served directly by Cloudflare Static Assets, before the Worker.
 * @remarks The fixed pathname rewrite cannot traverse into other files. Only conditional headers
 * are forwarded; assets retain ETags and HEAD behavior. Cache for a day, allowing updated artwork
 * at stable URLs to propagate. SVG documents cannot execute scripts or load external resources.
 */
export async function brandAsset(
    request: Request,
    env: Pick<Env, "ASSETS">,
): Promise<Response> {
    const filename = BRAND_ASSET_PATH.exec(new URL(request.url).pathname)?.[1];
    if (!filename)
        throw new ApiError(404, "not_found", "Brand image not found.");
    const headers = new Headers();
    for (const name of ["If-None-Match", "If-Modified-Since"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
    }
    const response = await env.ASSETS.fetch(
        new Request(`https://assets.local/static/image/brand/${filename}`, {
            method: request.method,
            headers,
        }),
    );
    if (response.status !== 200 && response.status !== 304) {
        await response.body?.cancel();
        throw new ApiError(404, "not_found", "Brand image not found.");
    }
    const output = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders))
        output.set(key, value);
    for (const [key, value] of Object.entries(assetHeaders))
        output.set(key, value);
    return new Response(response.body, {
        status: response.status,
        headers: output,
    });
}
