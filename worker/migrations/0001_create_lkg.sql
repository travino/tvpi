-- D1 last-known-good store for the Worker's L3a fallback layer.
-- One row per channel; the cron UPSERTs the freshest resolved TVP token URL.
-- Apply with: wrangler d1 migrations apply tvpi-lkg --remote
CREATE TABLE IF NOT EXISTS lkg (
  slug TEXT PRIMARY KEY,  -- channel slug (tvp1, tvp2, …); PK gives the indexed read-path lookup
  url  TEXT NOT NULL,     -- last successfully-resolved tokenized HLS URL
  ts   INTEGER NOT NULL   -- Date.now() of the write; read path ignores rows older than LKG_MAX_AGE_MS
);
