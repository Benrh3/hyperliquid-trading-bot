/**
 * Venue — minimal cross-exchange interface used by the execution layer.
 *
 * Each venue implementation provides market data reads (getFundingRate,
 * getMarkPrice, getPosition) and execution writes (openPosition,
 * closePosition).  Implementations that do not yet support trading throw
 * "not implemented" from the write methods.
 *
 * Design notes:
 *  - No bus coupling: venues are pure async call-response, no EventEmitter.
 *  - Prices are returned as plain numbers (USD).  Rates are per-hour decimals
 *    (e.g. 0.0001 = 0.01 %/hr) to match the Hyperliquid convention.
 *  - sizeUsd is in notional USD so callers do not need to know lot-size rules.
 */

export interface VenuePosition {
  coin:          string;
  side:          "long" | "short";
  /** Base-asset quantity (e.g. 0.01 BTC). */
  size:          number;
  entryPrice:    number;
  markPrice:     number;
  unrealisedPnl: number;
}

export interface OrderReceipt {
  orderId:   string;
  fillPrice: number;
  fillSize:  number;
  /** Realised PnL in USD — populated on close orders, undefined on opens. */
  pnl?:      number;
}

export interface Venue {
  /** Short identifier used in logs, e.g. "hyperliquid" | "dydx". */
  readonly name: string;

  /**
   * Current hourly funding rate as a decimal.
   * Positive = longs pay shorts; negative = shorts pay longs.
   * Returns null when the venue cannot provide a rate for this coin.
   */
  getFundingRate(coin: string): Promise<number | null>;

  /**
   * Current mark (or oracle) price in USD.
   * Returns null when unavailable.
   */
  getMarkPrice(coin: string): Promise<number | null>;

  /**
   * Open a new market position.
   * Implementations should size the order as sizeUsd / markPrice and use an
   * IOC limit order with a slippage cushion to guarantee a fill.
   */
  openPosition(
    coin:    string,
    side:    "long" | "short",
    sizeUsd: number,
  ): Promise<OrderReceipt>;

  /**
   * Close the current open position for this coin using a reduce-only order.
   * Returns fill details including realised PnL.
   */
  closePosition(coin: string): Promise<OrderReceipt>;

  /**
   * Query exchange fills for a coin since `sinceMs` and return total closedPnl
   * (exchange-computed, includes liquidation fills). Optional — only implemented
   * by venues that support fill history queries.
   */
  getClosedPnlForCoin?(coin: string, sinceMs: number): Promise<{
    totalClosedPnl: number;
    closingFills: Array<{ time: number; side: string; px: number; sz: number; closedPnl: number; fee: number; hash: string }>;
  }>;

  /**
   * Returns the open position for this coin, or null if flat.
   * Implementations should query the exchange's live state rather than relying
   * on cached data so callers always see the real position.
   */
  getPosition(coin: string): Promise<VenuePosition | null>;

  /**
   * Returns the total marked account equity in USD, or null if unavailable
   * (e.g. read-only venue with no wallet configured).  Used by the position-
   * sizing formula so that trade size scales with real account balance.
   */
  getAccountEquity(): Promise<number | null>;

  /**
   * Verifies the venue is fully configured for live order placement.
   * Throws a descriptive error if trading is not possible (missing credentials,
   * client initialization failure, etc.).  A no-op if trading is ready.
   *
   * Called by the cross-venue pre-flight check BEFORE placing any order on any
   * venue, so a missing mnemonic or broken signer is caught before the first leg.
   */
  checkTradingReady(): Promise<void>;

  /**
   * Returns ALL currently open positions on the account.
   * Used by the reconciliation loop to detect orphaned positions.
   * Returns empty array when unavailable (read-only venue, no wallet).
   */
  getAllPositions(): Promise<VenuePosition[]>;
}
