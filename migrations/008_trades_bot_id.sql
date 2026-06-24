-- Add bot_id to trades for per-bot P&L attribution.
-- Nullable so pre-migration rows degrade gracefully to strategy+coin fallback.
-- Historical rows cannot be reliably back-attributed (multiple bots may
-- share a strategy+coin), so they stay NULL.

ALTER TABLE trades ADD COLUMN bot_id TEXT;
CREATE INDEX IF NOT EXISTS idx_trades_bot_id ON trades(bot_id);
