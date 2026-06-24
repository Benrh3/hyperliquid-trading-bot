-- Persisted CVD trade buckets for warm restart.
-- One row per tracker (perp/spot per coin) containing the bucket ring buffer as JSON.
-- Written on each snapshot poll; rehydrated on startup so CVD windows
-- are warm immediately instead of null for hours.

CREATE TABLE IF NOT EXISTS cvd_tracker_state (
  tracker_id   TEXT PRIMARY KEY,
  boot_time    INTEGER NOT NULL,
  buckets_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);
