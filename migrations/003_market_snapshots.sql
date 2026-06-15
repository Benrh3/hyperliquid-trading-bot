-- ── Market data snapshots (observe-only Market section) ────────────────────
-- Tall/EAV layout: one snapshots row per (symbol, poll cycle), with each
-- metric value stored as its own row in snapshot_metrics. This lets new
-- metrics be added purely via the manifest, with no migrations, and keeps
-- hype-only metrics from forcing null columns onto other symbols.
--
-- Retention: raw snapshot_metrics rows kept for snapshot.retentionRawDays
-- (config/snapshot.json); older rows are rolled up to snapshot_metrics_hourly.
CREATE TABLE IF NOT EXISTS snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT    NOT NULL,
  network     TEXT    NOT NULL,
  captured_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_symbol_captured ON snapshots(symbol, captured_at);

CREATE TABLE IF NOT EXISTS snapshot_metrics (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  metric_key  TEXT    NOT NULL,
  value       REAL,
  source      TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  meta_json   TEXT,
  captured_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshot_metrics_key_captured ON snapshot_metrics(metric_key, captured_at);
CREATE INDEX IF NOT EXISTS idx_snapshot_metrics_snapshot      ON snapshot_metrics(snapshot_id);

-- Hourly rollup of snapshot metrics older than the raw retention window.
CREATE TABLE IF NOT EXISTS snapshot_metrics_hourly (
  ts_hour    INTEGER NOT NULL,
  symbol     TEXT    NOT NULL,
  metric_key TEXT    NOT NULL,
  avg_value  REAL,
  source     TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (ts_hour, symbol, metric_key)
);
CREATE INDEX IF NOT EXISTS idx_smh_ts ON snapshot_metrics_hourly(ts_hour);
