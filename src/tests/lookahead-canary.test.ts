/**
 * Lookahead canary test for signal-replay alignment.
 *
 * Constructs a scenario where a "perfect oracle" signal is available:
 * oracle[i].value = direction of candle[i+1] (future information).
 *
 * Backtest B (LOOKAHEAD): oracle published at candle[i]'s timestamp →
 *   at-or-before lookup finds it at candle i → strategy has foresight →
 *   win rate near 100%.
 *
 * Backtest A (NO LOOKAHEAD): oracle published one interval LATER →
 *   at-or-before at candle[i] finds oracle[i-1] (current bar's direction,
 *   already known) → fills in candle[i+1] which moves in the OPPOSITE
 *   direction for the alternating pattern → win rate near 0%.
 *
 * If A and B produce similar win rates, the alignment layer is broken
 * (either leaking lookahead into A, or blocking correct data in B).
 */

import { describe, it, expect } from "vitest";
import { attachSignals, runBacktest } from "../backtest.js";
import type { Candle, Signal } from "../events.js";
import type { Strategy } from "../strategy/base.js";

const H = 3_600_000; // 1 hour in ms
const N = 200;       // candles — 35 warmup + 165 active bars

// ── Price series: strict alternating ±1% ─────────────────────────────────────
// dirs[i] = direction of candle[i]: +1 for even bars, -1 for odd bars
const dirs = Array.from({ length: N }, (_, i) => (i % 2 === 0 ? 1 : -1));
const prices: number[] = [100];
for (const d of dirs) prices.push(prices[prices.length - 1] * (1 + d * 0.01));

// Candles: open = prices[i], close = prices[i+1]
const BASE_CANDLES: Candle[] = Array.from({ length: N }, (_, i) => ({
  timestamp: i * H,
  open:      prices[i],
  high:      Math.max(prices[i], prices[i + 1]),
  low:       Math.min(prices[i], prices[i + 1]),
  close:     prices[i + 1],
  volume:    1000,
}));

// Oracle: oracle[i].value = dirs[i+1] = direction of the NEXT bar.
// A strategy that can see oracle[i] at candle i has genuine foresight.
const ORACLE = Array.from({ length: N - 1 }, (_, i) => ({ value: dirs[i + 1] }));

// ── Inline strategy: reads candle.signals directly ───────────────────────────
// Uses candle.signals["oracle"] — sidesteps CustomStrategy's inTrade state.
// Returns long/short on every bar after warmup; the backtest engine handles
// reversal by closing the opposite position before opening the new one.
const WARMUP = 35;
class OracleStrategy implements Strategy {
  name = "oracle-canary";
  onCandle(candle: Candle, history: Candle[]): Signal | null {
    if (history.length < WARMUP) return null;
    const val = candle.signals?.["oracle"];
    if (val === undefined || val === null || isNaN(val as number)) return null;
    const coin = candle.coin ?? "HYPE";
    if (val > 0) return { side: "long",  coin, reason: "oracle+", timestamp: 0 };
    if (val < 0) return { side: "short", coin, reason: "oracle-", timestamp: 0 };
    return null;
  }
}

const BT_OPTS = {
  initialEquity:   1000,
  positionSizeUsd: 500,
  stopLossPct:     100,  // disabled — ±1% bars won't touch a 100% stop
  commissionPct:   0,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshCandles(): Candle[] {
  return BASE_CANDLES.map(c => ({ ...c }));
}

// Backtest B: oracle published at candle[i]'s timestamp (lookahead).
// at-or-before at candle[i] finds oracle[i] = dirs[i+1] → foresight.
function runB() {
  const candles = freshCandles();
  const series = ORACLE.map((o, i) => ({ capturedAt: i * H, value: o.value }));
  attachSignals(candles, new Map([["oracle", series]]));
  return runBacktest(new OracleStrategy(), candles, BT_OPTS);
}

// Backtest A: oracle published one interval LATER (no lookahead).
// at-or-before at candle[i] finds oracle[i-1] = dirs[i] (current bar direction).
// Candle[i+1] moves in direction dirs[i+1] = -dirs[i] → systematically wrong.
function runA() {
  const candles = freshCandles();
  const series = ORACLE.map((o, i) => ({ capturedAt: (i + 1) * H, value: o.value }));
  attachSignals(candles, new Map([["oracle", series]]));
  return runBacktest(new OracleStrategy(), candles, BT_OPTS);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Lookahead canary — alignment layer correctness", () => {

  it("Backtest B (lookahead) has near-perfect win rate and positive P&L", () => {
    const r = runB();

    // B sees oracle[i] at candle i → knows next bar's direction → nearly always wins.
    // With 200 bars and 35-bar warmup there are ~165 active bars → many trades.
    expect(r.tradeCount).toBeGreaterThan(50);
    expect(r.winRate).toBeGreaterThan(0.9);    // > 90% — genuine foresight
    expect(r.totalPnl).toBeGreaterThan(0);
  });

  it("Backtest A (no lookahead) has near-zero win rate and negative P&L", () => {
    const r = runA();

    // A sees oracle[i-1] = dirs[i] at candle i.
    // It bets in direction dirs[i], fills in candle i+1 which moves in direction
    // dirs[i+1] = -dirs[i]. Every trade is systematically wrong → ~0% win rate.
    expect(r.tradeCount).toBeGreaterThan(50);
    expect(r.winRate).toBeLessThan(0.15);      // < 15% — systematically wrong
    expect(r.totalPnl).toBeLessThan(0);
  });

  it("A and B produce materially different results", () => {
    const rA = runA();
    const rB = runB();

    expect(rB.totalPnl).toBeGreaterThan(rA.totalPnl);
    expect(rB.winRate - rA.winRate).toBeGreaterThan(0.6); // ≥60 pp gap
  });

  it("CRITICAL: if alignment leaks lookahead A win rate approaches B — must not happen", () => {
    const rA = runA();
    const rB = runB();
    // A leaking foresight would collapse the gap. ≥50 pp separation is required.
    expect(rB.winRate - rA.winRate).toBeGreaterThan(0.5);
  });

  it("both backtests produce meaningful trade counts (signal was consumed)", () => {
    const rA = runA();
    const rB = runB();
    expect(rA.tradeCount).toBeGreaterThan(20);
    expect(rB.tradeCount).toBeGreaterThan(20);
  });
});
