import { ApiError } from "./errors";
import { MAX_RESPONSE_BYTES } from "./feed";

export type Fetcher = (url: URL, init: RequestInit) => Promise<Response>;
interface FetchOptions {
    fetcher?: Fetcher;
    timeoutMs?: number;
    signal?: AbortSignal;
}

/**
 * Read a UTF-8 response within a byte budget, including chunked bodies without Content-Length.
 * @param response Successful origin/provider response whose body this function owns.
 * @param signal Shared request deadline; aborting also cancels the stream reader.
 * @param maximumBytes Maximum decompressed size (4 MiB RSS; callers use 256 KiB for Places).
 * @returns Strictly decoded text; the caller validates the format and schema.
 * @throws ApiError for missing bodies, invalid UTF-8 or size violations; provider callers remap it.
 * @remarks Reader cleanup is deliberately not awaited because a stalled origin must not extend the deadline.
 */
export async function readBounded(
    response: Response,
    signal: AbortSignal,
    maximumBytes = MAX_RESPONSE_BYTES,
): Promise<string> {
    if (!response.body)
        throw new ApiError(
            502,
            "invalid_feed",
            "FuelWatch returned an empty response.",
        );
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const abort = () => {
        void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
        signal.throwIfAborted();
        while (true) {
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maximumBytes)
                throw new ApiError(
                    502,
                    "response_too_large",
                    "FuelWatch response exceeds the size limit.",
                );
            chunks.push(value);
        }
        const body = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
        }
        try {
            return new TextDecoder("utf-8", {
                fatal: true,
                ignoreBOM: false,
            }).decode(body);
        } catch {
            throw new ApiError(
                502,
                "invalid_feed",
                "FuelWatch returned invalid text encoding.",
            );
        }
    } finally {
        signal.removeEventListener("abort", abort);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

/** Parse both standard Retry-After forms without allowing unbounded delays. */
export function retryAfterSeconds(
    value: string | null,
    now: number,
): number | undefined {
    if (!value) return undefined;
    if (/^\d+$/.test(value)) return Math.min(Number(value), 86400);
    const date = Date.parse(value);
    return Number.isFinite(date)
        ? Math.min(86400, Math.max(0, Math.ceil((date - now) / 1000)))
        : undefined;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal.addEventListener("abort", abort, { once: true });
    });

/** One deadline covers origin headers, body consumption, and the optional retry. */
export async function fetchFeed(
    url: URL,
    options: FetchOptions = {},
): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(
        () =>
            controller.abort(
                new DOMException("Deadline exceeded", "TimeoutError"),
            ),
        options.timeoutMs ?? 8000,
    );
    const signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;
    const fetcher = options.fetcher ?? fetch;
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            let delay = 250 + Math.floor(Math.random() * 250);
            try {
                signal.throwIfAborted();
                const response = await fetcher(url, {
                    signal,
                    redirect: "manual",
                    headers: {
                        Accept: "application/rss+xml, application/xml, text/xml",
                        "User-Agent": "FuelWatch-WA-Plus/1.0",
                    },
                });
                if (response.status === 200)
                    return await readBounded(response, signal);
                const retry = retryAfterSeconds(
                    response.headers.get("Retry-After"),
                    Date.now(),
                );
                void response.body?.cancel().catch(() => {});
                console.warn({
                    event: "upstream_http_error",
                    status: response.status,
                    attempt: attempt + 1,
                });
                if (response.status === 429 || response.status >= 500) {
                    if (attempt === 1 || (retry !== undefined && retry > 2))
                        throw new ApiError(
                            503,
                            "upstream_unavailable",
                            "FuelWatch is temporarily unavailable.",
                            retry,
                        );
                    delay = Math.max(delay, (retry ?? 0) * 1000);
                } else {
                    throw new ApiError(
                        502,
                        "upstream_denied",
                        "FuelWatch could not fulfil the request.",
                    );
                }
            } catch (error) {
                if (error instanceof ApiError) throw error;
                signal.throwIfAborted();
                if (attempt === 1)
                    throw new ApiError(
                        503,
                        "upstream_unavailable",
                        "FuelWatch could not be reached.",
                    );
            }
            await sleep(delay, signal);
        }
        throw new ApiError(
            503,
            "upstream_unavailable",
            "FuelWatch could not be reached.",
        );
    } catch (error) {
        if (signal.aborted)
            throw new ApiError(
                504,
                "upstream_timeout",
                "FuelWatch did not respond within the time limit.",
            );
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}
