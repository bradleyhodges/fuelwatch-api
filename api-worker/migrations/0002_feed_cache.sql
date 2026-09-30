-- Shared origin snapshots survive edge eviction and are keyed by absolute date and normalized filters.
CREATE TABLE feed_cache (
    cache_key TEXT PRIMARY KEY,
    owner TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX feed_cache_expiry ON feed_cache(expires_at);

-- Compressed chunks keep every row below D1's 2 MB limit, including multi-product feeds.
CREATE TABLE feed_cache_chunks (
    cache_key TEXT NOT NULL REFERENCES feed_cache(cache_key) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    payload BLOB NOT NULL,
    PRIMARY KEY (cache_key, chunk_index)
);
