// Shared types for the cex-agg source (market-spec.md §7 stage 4).
//
// Source-agnostic adapter: each venue (Binance/Bybit/OKX, and later a
// Coinglass aggregator) implements CexDerivsSource. The poller and registry
// only depend on this interface — adding a venue never touches the registry.

/** Long/short ratio fields — each null if the venue doesn't expose that stat for this symbol. */
export interface LongShortRatios {
  /** Account-level long/short ratio (>1 = more long accounts). */
  accountRatio: number | null;
  /** Top-trader position long/short ratio. */
  topPositionRatio: number | null;
  /** Taker buy/sell volume ratio. */
  takerRatio: number | null;
}

/**
 * One forced-liquidation event, normalized to coin units.
 * `side: "long"` = a long position was force-closed (forced SELL).
 * `side: "short"` = a short position was force-closed (forced BUY).
 */
export interface CexLiqEvent {
  side:     "long" | "short";
  qtyCoins: number;
  timeMs:   number;
}

/**
 * Per-venue adapter for CEX derivatives data. Implementations must be
 * defensive: network/parse errors are caught internally, logged once, and
 * surfaced as `null` / `isAvailable() === false` rather than thrown.
 */
export interface CexDerivsSource {
  readonly name: string;

  /** Resolve (and cache) this venue's symbol/instId for `coin`. Returns false if not listed. Never throws. */
  resolveSymbol(coin: string): Promise<boolean>;

  /** Whether resolveSymbol succeeded — i.e. this venue lists the symbol and is reachable. */
  isAvailable(): boolean;

  /** Open interest in coin units (not USD), or null if unavailable. Never throws. */
  fetchOpenInterest(): Promise<number | null>;

  /** Long/short ratios — individual fields null if unsupported. Never throws. */
  fetchLongShortRatios(): Promise<LongShortRatios>;

  /** Start the liquidation stream (idempotent). Pushes events via `onLiq`. Never throws. */
  startLiquidationStream(onLiq: (event: CexLiqEvent) => void): void;

  /** Stop the liquidation stream and release resources. */
  stopLiquidationStream(): void;
}

/**
 * Normalize an open-interest reading to coin units.
 * `unit: "usd"` divides by `markPx` (null if no mark price is available —
 * never fabricate a conversion).
 */
export function normalizeOi(raw: number, unit: "coins" | "usd", markPx: number | null): number | null {
  if (!Number.isFinite(raw)) return null;
  if (unit === "coins") return raw;
  if (markPx === null || !Number.isFinite(markPx) || markPx <= 0) return null;
  return raw / markPx;
}
