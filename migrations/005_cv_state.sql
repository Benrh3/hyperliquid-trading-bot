-- Cross-venue funding-arb bot state persistence.
-- Keyed by bot_id (matches BotConfig.id in bots.json).

CREATE TABLE IF NOT EXISTS cv_bot_state (
  bot_id           TEXT PRIMARY KEY,
  captured_funding REAL NOT NULL DEFAULT 0,
  total_fees       REAL NOT NULL DEFAULT 0,
  equity           REAL NOT NULL DEFAULT 0,
  periods          INTEGER NOT NULL DEFAULT 0,
  flip_count       INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER NOT NULL,
  total_leg_hold_ms INTEGER NOT NULL DEFAULT 0,
  last_bucket      INTEGER NOT NULL DEFAULT 0,
  last_flip_at     INTEGER NOT NULL DEFAULT 0,
  positioned       INTEGER NOT NULL DEFAULT 0,
  short_venue      TEXT NOT NULL DEFAULT '',
  long_venue       TEXT NOT NULL DEFAULT '',
  execution_mode   TEXT NOT NULL DEFAULT 'paper',
  notional         REAL NOT NULL DEFAULT 1000,
  daily_start_eq   REAL NOT NULL DEFAULT 0,
  hourly_accruals  TEXT NOT NULL DEFAULT '[]',
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cv_flip_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id      TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  from_short  TEXT NOT NULL DEFAULT '',
  from_long   TEXT NOT NULL DEFAULT '',
  to_short    TEXT NOT NULL,
  to_long     TEXT NOT NULL,
  spread      REAL NOT NULL,
  fee         REAL NOT NULL,
  equity_after REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cv_flip_bot_ts ON cv_flip_events (bot_id, ts);
