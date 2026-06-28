-- Hourly rollup of funding_spread_history rows older than 7 days.
-- Mirrors the pattern used for equity_history_hourly and funding_samples_hourly.
CREATE TABLE IF NOT EXISTS funding_spread_history_hourly (
  ts_hour      INTEGER NOT NULL,
  coin         TEXT    NOT NULL,
  avg_hl_funding   REAL,
  avg_dydx_funding REAL,
  avg_spread_abs   REAL,
  avg_hl_oi_usd    REAL,
  sample_count     INTEGER NOT NULL,
  PRIMARY KEY (ts_hour, coin)
);
CREATE INDEX IF NOT EXISTS idx_fshh_ts ON funding_spread_history_hourly(ts_hour);
