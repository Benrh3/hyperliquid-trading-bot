/**
 * Lookahead canary test for signal-replay alignment.
 *
 * attachSignals uses the bar's CLOSE time as the signal cutoff (not the open).
 * A signal published at or before candle[i]'s close is genuinely available
 * to a strategy that decides at bar close. A signal published after is not.
 *
 * Close time = candles[i+1].timestamp (the next bar's open).
 *
 * Constructs a perfect oracle: oracle[i].value = direction of candle[i+1].
 *
 * Backtest B (LOOKAHEAD): oracle published at candle[i]'s OPEN (i*H).
 *   Cutoff = close time (i+1)*H. i*H ≤ (i+1)*H → visible → foresight → ~100% win.
 *
 * Backtest A (NO LOOKAHEAD): oracle published TWO intervals ahead ((i+2)*H).
 *   Cutoff = close time (i+1)*H. (i+2)*H > (i+1)*H → NOT visible.
 *   Strategy sees oracle[i-2] = dirs[i-1] instead — stale, no predictive value.
 *   For the alternating pattern this is systematically wrong → ~0% win.
 *
 * If A and B produce similar win rates, the alignment layer is broken.
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

// Backtest B (lookahead): oracle published at close time of candle i = (i+1)*H.
// Cutoff = close time (i+1)*H. (i+1)*H ≤ (i+1)*H → oracle[i] visible (exact match).
// oracle[i+1].capturedAt = (i+2)*H > (i+1)*H → NOT visible → no confusion.
// Strategy at candle i sees dirs[i+1] (the fill bar's direction) → ~100% win.
function runB() {
  const candles = freshCandles();
  const series = ORACLE.map((o, i) => ({ capturedAt: (i + 1) * H, value: o.value }));
  attachSignals(candles, new Map([["oracle", series]]));
  return runBacktest(new OracleStrategy(), candles, BT_OPTS);
}

// Backtest A (no lookahead): oracle published ONE interval past close = (i+2)*H.
// Cutoff = close time (i+1)*H. (i+2)*H > (i+1)*H → oracle[i] NOT visible.
// Candle[i] instead sees oracle[i-1] (capturedAt = i*H ≤ (i+1)*H) = dirs[i].
// Bets dirs[i], fills in candle[i+1] which moves dirs[i+1] = -dirs[i] → always wrong.
function runA() {
  const candles = freshCandles();
  const series = ORACLE.map((o, i) => ({ capturedAt: (i + 2) * H, value: o.value }));
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

    // A's oracle published at (i+2)*H, cutoff is close time (i+1)*H.
    // Not visible → candle[i] sees oracle[i-2] = dirs[i-1].
    // Bets dirs[i-1], fills in candle[i+1] which moves dirs[i+1] = -dirs[i-1].
    // Systematically wrong for the alternating pattern → ~0% win rate.
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
