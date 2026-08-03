-- Persisted CEX liquidation tracker buckets for warm restart.
-- One row per (venue, symbol) tracker containing the bucket ring buffer as JSON.
-- Written on each snapshot poll and on clean shutdown; rehydrated on startup so
-- cex_liq_* windows survive a snapshot-poller restart instead of resetting to 0.
-- Same shape as cvd_tracker_state (007_cvd_buckets.sql) — kept as a separate
-- table since these track a different subsystem (CexLiqTracker, not CvdTracker).

CREATE TABLE IF NOT EXISTS liq_tracker_state (
  tracker_id   TEXT PRIMARY KEY,
  boot_time    INTEGER NOT NULL,
  buckets_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);
