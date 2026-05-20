import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { config } from "./config.js";
import type { Candle, Signal } from "./events.js";
import type { Strategy } from "./strategy/base.js";

const SLIPPAGE = 0.0005; // 0.05%

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
  pnl:        number;
  reason:     string;
}

export interface BacktestResult {
  totalPnl:       number;
  winRate:        number;
  tradeCount:     number;
  maxDrawdownPct: number;
  profitFactor:   number;
  sharpeRatio:    number;
  trades:         BacktestTrade[];
  equityCurve:    { time: number; equity: number }[];
}

interface BacktestOptions {
  initialEquity?:   number;
  positionSizeUsd?: number;
  stopLossPct?:     number;
}

export function runBacktest(
  strategy: Strategy,
  candles: Candle[],
  { initialEquity = 1000, positionSizeUsd = 500, stopLossPct = 2 }: BacktestOptions = {},
): BacktestResult {
  const trades: BacktestTrade[] = [];
  const equityCurve: { time: number; equity: number }[] = [];

  let equity = initialEquity;
  let position: {
    side:       "long" | "short";
    entryPrice: number;
    entryTime:  number;
    size:       number;
  } | null = null;

  const history: Candle[] = [];

  function closeTrade(exitPrice: number, exitTime: number, reason: string): void {
    if (!position) return;
    const { side, entryPrice, entryTime, size } = position;
    const pnl = side === "long"
      ? (exitPrice - entryPrice) * size
      : (entryPrice - exitPrice) * size;
    trades.push({ index: trades.length, side, entryTime, entryPrice, exitTime, exitPrice, size, pnl, reason });
    equity += pnl;
    position = null;
  }

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    history.push(candle);

    // Stop-loss on candle wicks
    if (position) {
      const { side, entryPrice } = position;
      const loss = side === "long"
        ? (entryPrice - candle.low)  / entryPrice * 100
        : (candle.high - entryPrice) / entryPrice * 100;
      if (loss >= stopLossPct) {
        const stopPx = side === "long"
          ? entryPrice * (1 - stopLossPct / 100) * (1 - SLIPPAGE)
          : entryPrice * (1 + stopLossPct / 100) * (1 + SLIPPAGE);
        closeTrade(stopPx, candle.timestamp, `Stop-loss ${loss.toFixed(2)}%`);
        equityCurve.push({ time: candle.timestamp, equity });
        continue;
      }
    }

    const signal: Signal | null = strategy.onCandle(candle, history.slice());

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
          side: signal.side,
          entryPrice: entryPx,
          entryTime:  candle.timestamp,
          size:       positionSizeUsd / entryPx,
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
  const winners     = trades.filter((t) => t.pnl > 0);
  const losers      = trades.filter((t) => t.pnl < 0);
  const totalPnl    = trades.reduce((s, t) => s + t.pnl, 0);
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
    sharpeRatio = std > 0 ? (mean / std) * Math.sqrt(returns.length) : 0;
  }

  return { totalPnl, winRate, tradeCount: trades.length, maxDrawdownPct, profitFactor, sharpeRatio, trades, equityCurve };
}

export async function fetchCandles(coin: string, interval: string, limit: number): Promise<Candle[]> {
  const isTestnet  = config.exchange.network === "testnet";
  const infoClient = new InfoClient({ transport: new HttpTransport({ isTestnet }) });
  const intervalMs = BACKTEST_INTERVAL_MS[interval] ?? 60_000;
  const endTime    = Date.now();
  const startTime  = endTime - limit * intervalMs;

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
