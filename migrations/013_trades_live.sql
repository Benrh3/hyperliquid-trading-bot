-- Add live column to trades to distinguish paper simulations from real orders.
-- Nullable so pre-migration rows degrade gracefully (displayed as unknown).
ALTER TABLE trades ADD COLUMN live INTEGER;
