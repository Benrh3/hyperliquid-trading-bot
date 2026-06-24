-- Per-coin funding spread history for long-run analysis.
-- One row per coin per matrix refresh (~every 60s × N coins).
-- Retention note: grows ~N coins/min; fine for months, but
-- consider downsampling >90d to hourly averages later.

CREATE TABLE IF NOT EXISTS funding_spread_history (
  ts              INTEGER NOT NULL,
  coin            TEXT    NOT NULL,
  hl_funding      REAL,
  dydx_funding    REAL,
  spread_abs      REAL,
  spread_dir      TEXT,
  hl_oi_usd       REAL,
  PRIMARY KEY (coin, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_fsh_ts ON funding_spread_history (ts);
