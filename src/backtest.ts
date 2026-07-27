import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { config } from "./config.js";
import type { Candle, Signal } from "./events.js";
import type { Strategy } from "./strategy/base.js";

const SLIPPAGE = 0.0005; // 0.05%

// Funding-rate signal key used for per-bar accrual.
// Must match FundingExtremeStrategy.SIGNAL_KEY and the key written by attachSignals().
// Accrual only fires when this key is present and finite on a candle; unsignalled
// candles (and all candle-only strategies) are completely unaffected.
const FUNDING_SIGNAL_KEY = "funding_rate";

export const BACKTEST_INTERVAL_MS: Record<string, number> = {
  "1m":  60_000,
  "3m":  3 * 60_000,
  "5m":  5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h":  60 * 60_000,
  "2h":  2 * 60 * 60_000,
  "4h":  4 * 60 * 60_000,
  "8h":  8 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d":  24 * 60 * 60_000,
};

export interface BacktestTrade {
  index:      number;
  side:       "long" | "short";
  entryTime:  number;
  entryPrice: number;
  exitTime:   number;
  exitPrice:  number;
  size:       number;
  pricePnl:   number;   // price-move P&L net of commission; excludes funding
  fundingPnl: number;   // cumulative funding accrual while position was open
  pnl:        number;   // total = pricePnl + fundingPnl
  reason:     string;
}

export interface BuyHoldResult {
  returnPct:      number;
  equityCurve:    { time: number; equity: number }[];
  maxDrawdownPct: number;
}

export interface BacktestResult {
  totalPricePnl:   number;   // price-move P&L net of commission, summed across all trades
  totalFundingPnl: number;   // funding accrual P&L, summed across all trades
  totalPnl:        number;   // = totalPricePnl + totalFundingPnl
  winRate:         number;
  tradeCount:      number;
  maxDrawdownPct:  number;
  profitFactor:    number;
  sharpeRatio:     number;
  trades:          BacktestTrade[];
  equityCurve:     { time: number; equity: number }[];
  buyHold:         BuyHoldResult;
}

interface BacktestOptions {
  initialEquity?:   number;
  positionSizeUsd?: number;
  stopLossPct?:     number;
  commissionPct?:   number;   // per-side decimal fraction, e.g. 0.0005 for 0.05%
}

export function runBacktest(
  strategy: Strategy,
  candles: Candle[],
  { initialEquity = 1000, positionSizeUsd = 500, stopLossPct = 2, commissionPct = 0 }: BacktestOptions = {},
): BacktestResult {
  const trades: BacktestTrade[] = [];
  const equityCurve: { time: number; equity: number }[] = [];

  let equity = initialEquity;
  let position: {
    side:            "long" | "short";
    entryPrice:      number;
    entryTime:       number;
    size:            number;
    accruedFunding:  number;   // funding P&L accumulated bar-by-bar while position is open
  } | null = null;

  const history: Candle[] = [];

  function closeTrade(exitPrice: number, exitTime: number, reason: string): void {
    if (!position) return;
    const { side, entryPrice, entryTime, size, accruedFunding } = position;
    const rawPricePnl = side === "long"
      ? (exitPrice - entryPrice) * size
      : (entryPrice - exitPrice) * size;
    // Two-sided commission: charged on entry notional + exit notional
    const commission = commissionPct * size * (entryPrice + exitPrice);
    const pricePnl   = rawPricePnl - commission;
    const fundingPnl = accruedFunding;
    const pnl        = pricePnl + fundingPnl;
    trades.push({ index: trades.length, side, entryTime, entryPrice, exitTime, exitPrice, size, pricePnl, fundingPnl, pnl, reason });
    equity += pnl;
    position = null;
  }

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    history.push(candle);

    // Accrue funding for the open position.
    // Notional = entryPrice × size = positionSizeUsd (approximation; mark-price drift
    // not modelled — entry notional is constant throughout the hold).
    // Short receives positive funding (longs pay carry); long pays positive (shorts receive).
    // No FUNDING_SIGNAL_KEY on this candle → zero accrual → behavior unchanged for
    // candle-only strategies and any existing test that does not attach funding signals.
    if (position) {
      const rate = candle.signals?.[FUNDING_SIGNAL_KEY];
      if (rate !== null && rate !== undefined && isFinite(rate as number)) {
        const direction = position.side === "short" ? 1 : -1;
        position.accruedFunding += (position.entryPrice * position.size) * (rate as number) * direction;
      }
    }

    // Stop-loss triggered by candle wick breaching the stop level.
    // Fill convention: stop-price fill — assumes a stop-limit order fills at exactly
    // entryPrice × (1 ± stopLossPct/100), plus slippage. Intra-bar gap risk is not
    // modelled; fills on extreme gaps will be worse in practice. Reason reports the
    // realized fill-based loss (not the wick exceedance) so it matches trade P&L.
    if (position) {
      const { side, entryPrice } = position;
      const wickLoss = side === "long"
        ? (entryPrice - candle.low)  / entryPrice * 100
        : (candle.high - entryPrice) / entryPrice * 100;
      if (wickLoss >= stopLossPct) {
        const stopPx = side === "long"
          ? entryPrice * (1 - stopLossPct / 100) * (1 - SLIPPAGE)
          : entryPrice * (1 + stopLossPct / 100) * (1 + SLIPPAGE);
        const fillLossPct = Math.abs(stopPx - entryPrice) / entryPrice * 100;
        closeTrade(stopPx, candle.timestamp, `Stop-loss −${fillLossPct.toFixed(2)}%`);
        equityCurve.push({ time: candle.timestamp, equity });
        continue;
      }
    }

    const signal: Signal | null = strategy.onCandle(candle, history);

    // Use next candle open for fill (realistic)
    const fillOpen = candles[i + 1]?.open ?? candle.close;

    if (signal?.side === "close" && position) {
      const exitPx = position.side === "long"
        ? fillOpen * (1 - SLIPPAGE)
        : fillOpen * (1 + SLIPPAGE);
      closeTrade(exitPx, candle.timestamp, signal.reason);
    } else if (signal?.side === "long" || signal?.side === "short") {
      if (position && position.side !== signal.side) {
        const exitPx = position.side === "long"
          ? fillOpen * (1 - SLIPPAGE)
          : fillOpen * (1 + SLIPPAGE);
        closeTrade(exitPx, candle.timestamp, `Reversed to ${signal.side}`);
      }
      if (!position) {
        const entryPx: number = signal.side === "long"
          ? fillOpen * (1 + SLIPPAGE)
          : fillOpen * (1 - SLIPPAGE);
        position = {
          side:           signal.side,
          entryPrice:     entryPx,
          entryTime:      candle.timestamp,
          size:           positionSizeUsd / entryPx,
          accruedFunding: 0,
        };
      }
    }

    equityCurve.push({ time: candle.timestamp, equity });
  }

  // Close any open position at end of data
  if (position && candles.length > 0) {
    const last   = candles[candles.length - 1];
    const exitPx = position.side === "long"
      ? last.close * (1 - SLIPPAGE)
      : last.close * (1 + SLIPPAGE);
    closeTrade(exitPx, last.timestamp, "End of backtest");
    equityCurve.push({ time: last.timestamp, equity });
  }

  // ── Metrics ──────────────────────────────────────────────────────────────
  const winners        = trades.filter((t) => t.pnl > 0);
  const losers         = trades.filter((t) => t.pnl < 0);
  const totalPricePnl  = trades.reduce((s, t) => s + t.pricePnl,  0);
  const totalFundingPnl = trades.reduce((s, t) => s + t.fundingPnl, 0);
  const totalPnl       = totalPricePnl + totalFundingPnl;
  const winRate     = trades.length > 0 ? winners.length / trades.length : 0;
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss   = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

  // Max drawdown from equity curve
  let peak = initialEquity;
  let maxDrawdownPct = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak > 0 ? (peak - pt.equity) / peak * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  // Simplified Sharpe based on per-trade returns
  let sharpeRatio = 0;
  if (trades.length > 1) {
    const returns  = trades.map((t) => t.pnl / (t.entryPrice * t.size));
    const mean     = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std      = Math.sqrt(variance);
    sharpeRatio = std > 1e-10 ? (mean / std) * Math.sqrt(returns.length) : 0;
  }

  // ── Buy-and-hold benchmark ───────────────────────────────────────────────
  const buyHold: BuyHoldResult = { returnPct: 0, equityCurve: [], maxDrawdownPct: 0 };
  if (candles.length > 0) {
    const entryPrice = candles[0].close;
    const units = initialEquity / entryPrice;
    let bhPeak = initialEquity;
    for (const c of candles) {
      const bhEquity = units * c.close;
      buyHold.equityCurve.push({ time: c.timestamp, equity: bhEquity });
      if (bhEquity > bhPeak) bhPeak = bhEquity;
      const dd = (bhPeak - bhEquity) / bhPeak * 100;
      if (dd > buyHold.maxDrawdownPct) buyHold.maxDrawdownPct = dd;
    }
    buyHold.returnPct = (candles[candles.length - 1].close - entryPrice) / entryPrice * 100;
  }

  return { totalPricePnl, totalFundingPnl, totalPnl, winRate, tradeCount: trades.length, maxDrawdownPct, profitFactor, sharpeRatio, trades, equityCurve, buyHold };
}

// ── Funding basis (delta-neutral) backtest ───────────────────────────────────

interface FundingRecord {
  fundingRate: string;
  time: number;
}

export interface FundingBasisResult {
  netReturnPct:    number;
  netPnlUsd:       number;
  grossFundingPct: number;
  feeDragPct:      number;
  fundingPeriods:  number;
  annualisedPct:   number;
  equityCurve:     { time: number; equity: number }[];
}

const TAKER_FEE = 0.0005; // 0.05% per leg — matches live TAKER_FEE_PER_SIDE

export function runFundingBasisBacktest(
  records: FundingRecord[],
  initialEquity = 1000,
): FundingBasisResult {
  if (records.length === 0) {
    return { netReturnPct: 0, netPnlUsd: 0, grossFundingPct: 0, feeDragPct: 0, fundingPeriods: 0, annualisedPct: 0, equityCurve: [] };
  }

  const notional = initialEquity;
  // Entry: taker on spot buy + taker on perp short = 2 legs
  // Exit:  taker on spot sell + taker on perp close = 2 legs
  const entryFees  = 2 * TAKER_FEE * notional;
  const exitFees   = 2 * TAKER_FEE * notional;
  const feeDragUsd = entryFees + exitFees;
  const feeDragPct = (feeDragUsd / notional) * 100;

  // Build equity curve: entry fees deducted at open, funding accrues each period,
  // exit fees deducted at the final close.
  const baseEquity = notional - entryFees;
  let cumFunding = 0;
  const equityCurve: { time: number; equity: number }[] = [];

  for (const r of records) {
    cumFunding += parseFloat(r.fundingRate) * notional;
    equityCurve.push({ time: r.time, equity: baseEquity + cumFunding });
  }
  // Deduct exit fees from the closing point
  equityCurve[equityCurve.length - 1].equity -= exitFees;

  const grossFundingUsd = cumFunding;
  const grossFundingPct = (grossFundingUsd / notional) * 100;
  const netPnlUsd       = grossFundingUsd - feeDragUsd;
  const netReturnPct    = (netPnlUsd / notional) * 100;

  const windowMs   = records[records.length - 1].time - records[0].time;
  const windowDays = windowMs / 86_400_000;
  const annualisedPct = windowDays > 0 ? netReturnPct * (365 / windowDays) : 0;

  return { netReturnPct, netPnlUsd, grossFundingPct, feeDragPct, fundingPeriods: records.length, annualisedPct, equityCurve };
}

export async function fetchFundingHistory(coin: string, startTime: number, endTime: number): Promise<FundingRecord[]> {
  const infoClient = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });
  const raw = await infoClient.fundingHistory({ coin, startTime, endTime });
  return raw.map((r) => ({ fundingRate: r.fundingRate, time: r.time }));
}

// ── Signal attachment (backtest-only) ────────────────────────────────────────

export interface SignalTimeSeries {
  readonly capturedAt: number;
  readonly value:      number | null;
}

/**
 * Attach Market signal values to candles using a sorted merge.
 *
 * Cutoff semantics: for each candle the strategy's decision executes at the
 * bar's CLOSE time (candles[i+1].timestamp, or candle.timestamp + intervalMs
 * for the last bar). Signals published at or before that close time are
 * genuinely available to a live trader at decision time and are attached.
 * Signals published after the close are not attached.
 *
 * This is the correct boundary: using the bar OPEN as cutoff would miss
 * signals that arrive during the bar, creating a spurious one-bar lag.
 *
 * Both candles and signal series must be sorted ascending by timestamp.
 * The two-pointer merge is O(C + S) per signal and structurally prevents
 * lookahead — the signal pointer only ever advances forward.
 *
 * Returns signal coverage metadata for diagnostics.
 */
export function attachSignals(
  candles:   Candle[],
  signalMap: Map<string, ReadonlyArray<SignalTimeSeries>>,
): { key: string; filled: number; total: number }[] {
  if (signalMap.size === 0 || candles.length === 0) return [];

  // Infer interval from first consecutive pair; fall back to 0 (safe: uses open time for last bar)
  const inferredInterval = candles.length > 1
    ? candles[1].timestamp - candles[0].timestamp
    : 0;

  const coverage: { key: string; filled: number; total: number }[] = [];

  for (const [key, series] of signalMap) {
    let ptr = 0;
    let lastValue: number | null = null;
    let filled = 0;

    for (let ci = 0; ci < candles.length; ci++) {
      const candle = candles[ci];
      // Close time = next bar's open, or open + interval for the last bar
      const closeTime = candles[ci + 1]?.timestamp ?? (candle.timestamp + inferredInterval);

      // Advance pointer to the last entry at-or-before close time
      while (ptr < series.length && series[ptr].capturedAt <= closeTime) {
        lastValue = series[ptr].value;
        ptr++;
      }

      if (!candle.signals) candle.signals = {};
      candle.signals[key] = lastValue;
      if (lastValue !== null) filled++;
    }

    coverage.push({ key, filled, total: candles.length });
  }

  return coverage;
}

// ── Candle fetch ─────────────────────────────────────────────────────────────

export async function fetchCandles(coin: string, interval: string, limit: number): Promise<Candle[]> {
  const intervalMs = BACKTEST_INTERVAL_MS[interval] ?? 60_000;
  const endTime    = Date.now();
  const startTime  = endTime - limit * intervalMs;
  return fetchCandlesByRange(coin, interval, startTime, endTime);
}

export async function fetchCandlesByRange(coin: string, interval: string, startTime: number, endTime: number): Promise<Candle[]> {
  const infoClient = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });
  const raw = await infoClient.candleSnapshot({ coin, interval: interval as "1m", startTime, endTime });
  return raw.map((c) => ({
    timestamp: c.t,
    open:      parseFloat(c.o as unknown as string),
    high:      parseFloat(c.h as unknown as string),
    low:       parseFloat(c.l as unknown as string),
    close:     parseFloat(c.c as unknown as string),
    volume:    parseFloat(c.v as unknown as string),
  }));
}

/**
 * Resolve the stop-loss percentage for a backtest run.
 *
 * Precedence: if the strategy registry entry exposes a `stopLossPct` param,
 * use the value from mergedStrategyParams (falling back to that param's
 * registry default).  Otherwise fall back to the general stop passed by the
 * caller.  This is the single authority for stop resolution — both the
 * single-run and walk-forward route handlers import and call this function.
 */
export function resolveEffectiveStop(
  params: ReadonlyArray<{ key: string; default: number }>,
  mergedStrategyParams: Readonly<Record<string, number>>,
  generalStop: number,
): number {
  const ownStop = params.find((p) => p.key === "stopLossPct");
  if (ownStop) {
    return mergedStrategyParams["stopLossPct"] ?? ownStop.default;
  }
  return generalStop;
}
