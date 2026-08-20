-- Settled hourly funding rates from exchange historicalFunding endpoints.
-- Populated by scripts/settled-static-replay.ts.
-- NOT the predicted rates in funding_samples (which come from the live poller).
CREATE TABLE IF NOT EXISTS settled_funding (
  venue           TEXT    NOT NULL,  -- "hyperliquid" | "dydx"
  coin            TEXT    NOT NULL,  -- "BTC" | "HYPE" | ...
  hour_ts         INTEGER NOT NULL,  -- epoch ms, exact hour boundary
  rate            REAL    NOT NULL,  -- hourly rate (fraction of notional)
  source_endpoint TEXT    NOT NULL,  -- exact URL/request used to obtain this row
  fetched_at      INTEGER NOT NULL,  -- epoch ms when this batch was fetched
  PRIMARY KEY (venue, coin, hour_ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sf_coin_ts ON settled_funding (coin, hour_ts);
