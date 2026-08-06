-- Bot archive: snapshot row written when a bot is retired.
-- Trades, cv_flip_events, and cv_bot_state rows are NOT deleted on retire;
-- they remain queryable via bot_id.  Only the active-bot registry entry is removed.
CREATE TABLE IF NOT EXISTS bot_archive (
  id              TEXT PRIMARY KEY,
  strategy_id     TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  coin            TEXT NOT NULL,
  timeframe       TEXT NOT NULL,
  live            INTEGER NOT NULL DEFAULT 0,
  execution_mode  TEXT,              -- 'paper' | 'live' for CV bots; NULL for candle bots
  started_at      INTEGER NOT NULL,
  retired_at      INTEGER NOT NULL,
  starting_equity REAL NOT NULL DEFAULT 1000,

  -- Durable P&L snapshot
  realised_pnl    REAL NOT NULL DEFAULT 0,
  trade_count     INTEGER NOT NULL DEFAULT 0,
  win_rate        REAL,              -- fraction 0–1; NULL for CV bots (no trade rows)
  max_drawdown_pct REAL,            -- peak-to-trough % of starting equity; NULL for CV bots

  -- Comparable realized metrics (annualized for WF comparison)
  lifetime_hours        REAL NOT NULL DEFAULT 0,
  annualized_return_pct REAL,       -- lifetimeReturnPct × (8760 / lifetimeHours)
  realized_sharpe       REAL,       -- trade-level Sharpe; NULL for CV bots or < 2 trades

  -- Walk-forward prediction snapshot (NULL if no matching WF result existed at retire time)
  wf_strategy_id       TEXT,
  wf_coin              TEXT,
  wf_mean_oos_sharpe   REAL,
  wf_mean_oos_return_pct REAL,
  wf_pct_beat_bh       REAL,
  wf_run_at            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bot_archive_retired ON bot_archive(retired_at DESC);
