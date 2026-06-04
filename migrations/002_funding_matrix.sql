-- ── Equity history ──────────────────────────────────────────────────────────
-- Snapshots of total account equity, taken every 60 s.
-- Retention: raw rows kept 7 days; older rows are rolled up to equity_history_hourly.
CREATE TABLE IF NOT EXISTS equity_history (
  ts         INTEGER NOT NULL PRIMARY KEY,   -- epoch ms
  equity_usd REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equity_history_ts ON equity_history(ts);

-- Hourly rollup of equity snapshots older than 7 days.
CREATE TABLE IF NOT EXISTS equity_history_hourly (
  ts_hour        INTEGER NOT NULL PRIMARY KEY,  -- epoch ms, floored to hour boundary
  avg_equity_usd REAL    NOT NULL,
  sample_count   INTEGER NOT NULL
);

-- ── Funding-rate time series ──────────────────────────────────────────────────
-- One row per (poll cycle, coin, venue). Written fire-and-forget.
-- Retention: raw rows kept 7 days; older rows are rolled up to funding_samples_hourly.
CREATE TABLE IF NOT EXISTS funding_samples (
  ts          INTEGER NOT NULL,   -- epoch ms of the poll cycle
  coin        TEXT    NOT NULL,
  venue       TEXT    NOT NULL,
  rate_hourly REAL    NOT NULL,
  PRIMARY KEY (ts, coin, venue)
);
CREATE INDEX IF NOT EXISTS idx_funding_samples_ts   ON funding_samples(ts);
CREATE INDEX IF NOT EXISTS idx_funding_samples_coin ON funding_samples(coin);

-- Hourly rollup of funding samples older than 7 days.
CREATE TABLE IF NOT EXISTS funding_samples_hourly (
  ts_hour        INTEGER NOT NULL,  -- epoch ms, floored to hour boundary
  coin           TEXT    NOT NULL,
  venue          TEXT    NOT NULL,
  avg_rate_hourly REAL   NOT NULL,
  sample_count   INTEGER NOT NULL,
  PRIMARY KEY (ts_hour, coin, venue)
);
CREATE INDEX IF NOT EXISTS idx_fsh_ts   ON funding_samples_hourly(ts_hour);
CREATE INDEX IF NOT EXISTS idx_fsh_coin ON funding_samples_hourly(coin);
