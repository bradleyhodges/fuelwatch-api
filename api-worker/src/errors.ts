export type ErrorCode =
    | "invalid_query"
    | "invalid_feed"
    | "response_too_large"
    | "upstream_denied"
    | "upstream_unavailable"
    | "upstream_timeout"
    | "cache_refresh_busy"
    | "not_found"
    | "method_not_allowed"
    | "unsupported_media_type"
    | "not_acceptable"
    | "internal_error";

/** Safe public errors never contain upstream bodies, URLs or exception details. */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: ErrorCode,
        message: string,
        readonly retryAfter?: number,
    ) {
        super(message);
        this.name = "ApiError";
    }
}
