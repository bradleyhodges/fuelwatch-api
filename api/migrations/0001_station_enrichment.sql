-- Only the scheduled refresh writes provider records. Public requests read this cache.
CREATE TABLE station_enrichment (
    station_key TEXT PRIMARY KEY,
    seed_json TEXT NOT NULL CHECK (json_valid(seed_json)),
    last_seen_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    place_id TEXT,
    enrichment_json TEXT CHECK (enrichment_json IS NULL OR json_valid(enrichment_json))
);
CREATE INDEX station_enrichment_due ON station_enrichment(next_attempt_at, last_seen_at);

-- One lease fences overlapping cron invocations, including invocation retries.
CREATE TABLE enrichment_refresh (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER NOT NULL DEFAULT 0,
    next_product INTEGER NOT NULL DEFAULT 0
);
INSERT INTO enrichment_refresh(id) VALUES (1);

-- A request is reserved before sending it, even if it later fails or times out.
CREATE TABLE google_request_budget (
    utc_day TEXT PRIMARY KEY,
    requests INTEGER NOT NULL CHECK (requests >= 0)
);
