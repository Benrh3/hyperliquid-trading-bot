/**
 * candle-cache-utils.ts — pure helpers for the on-demand candle endpoint.
 * Extracted so they can be unit-tested without a running server.
 */

export const VALID_INTERVALS = [
  "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "8h", "12h", "1d",
] as const;
export type CandleInterval = (typeof VALID_INTERVALS)[number];

/**
 * Stable cache key for a coin+interval combination.
 * Always uppercase-normalises coin so "btc" and "BTC" share the same entry.
 */
export function makeCacheKey(coin: string, interval: string): string {
  return `${coin.toUpperCase().trim()}:${interval}`;
}

/**
 * Returns true when `coin` (case-insensitive) is present in the Hyperliquid
 * perpetuals universe list.  `universe` must be an array of uppercase names.
 */
export function isValidCoin(coin: string, universe: string[]): boolean {
  if (!coin || typeof coin !== "string") return false;
  const upper = coin.toUpperCase().trim();
  return universe.some((u) => u === upper);
}

/**
 * Returns true when `interval` is one of the intervals supported by the
 * Hyperliquid candleSnapshot endpoint.
 */
export function isValidInterval(interval: string): interval is CandleInterval {
  return (VALID_INTERVALS as readonly string[]).includes(interval);
}
