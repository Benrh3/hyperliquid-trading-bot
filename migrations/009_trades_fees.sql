-- Per-trade fee column for net P&L attribution.
-- Nullable so pre-migration rows (gross P&L, no fee data) degrade gracefully.
-- Historical rows are NOT backfilled — their notionals can't be reliably
-- reconstructed. Display code should treat NULL fees as "gross, pre-fee-tracking".

ALTER TABLE trades ADD COLUMN fees REAL;
