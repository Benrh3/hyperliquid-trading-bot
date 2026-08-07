-- Swing Advisor: flip log and current state per horizon.
-- Written by the SwingAdvisorPoller (snapshot-poller process).
-- Read by routes.ts via Logger query methods (main bot process).

CREATE TABLE IF NOT EXISTS swing_flip_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      INTEGER NOT NULL,      -- unix ms of the flip
  horizon         TEXT    NOT NULL,      -- 'daily' | 'weekly' | 'monthly'
  old_call        TEXT    NOT NULL,      -- 'LONG' | 'SHORT' | 'STAND ASIDE'
  new_call        TEXT    NOT NULL,
  hype_price      REAL,                  -- mark price at flip time (null if unavailable)
  regime          TEXT    NOT NULL,      -- 'CALM-TRENDING' | 'HIGH-VOL' | 'CHOP'
  agreement_score REAL,
  composite_score REAL,
  voices_json     TEXT    NOT NULL,      -- JSON array of VoiceResult (with effectiveStrength)
  forward_return  REAL,                  -- filled in by background job after horizon elapses
  fill_after_at   INTEGER NOT NULL       -- unix ms: when forward_return can first be filled
);
CREATE INDEX IF NOT EXISTS idx_swing_flip_horizon_created ON swing_flip_log(horizon, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_swing_flip_unfilled        ON swing_flip_log(fill_after_at);

-- One row per horizon; upserted on every computation cycle.
CREATE TABLE IF NOT EXISTS swing_current_state (
  horizon          TEXT    PRIMARY KEY,
  call             TEXT    NOT NULL,     -- current call
  updated_at       INTEGER NOT NULL,     -- ms — when the call last changed
  last_computed_at INTEGER NOT NULL,     -- ms — when the state was last recomputed
  regime           TEXT    NOT NULL,
  composite_score  REAL,
  agreement_score  REAL,
  voices_json      TEXT    NOT NULL,
  last_notified_at INTEGER              -- ms — for Telegram rate-limiting (NULL = never sent)
);
