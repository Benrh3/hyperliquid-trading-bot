import { describe, it, expect } from "vitest";
import { FundingExtremeStrategy, SIGNAL_KEY } from "../strategy/funding-extreme.js";
import { STRATEGY_REGISTRY } from "../strategy/registry.js";
import { runBacktest } from "../backtest.js";
import type { Candle } from "../events.js";

const H = 3_600_000; // 1 hour in ms

function makeCandle(timestamp: number, funding: number | null): Candle {
  const c: Candle = { timestamp, open: 100, high: 101, low: 99, close: 100, volume: 1000 };
  if (funding !== null) c.signals = { [SIGNAL_KEY]: funding };
  return c;
}

const DEFAULT_RATE  = 1.25e-5;
const SHORT_MULT    = 3;
const SHORT_THRESH  = DEFAULT_RATE * SHORT_MULT;          // 3.75e-5
const EXIT_BAND     = 0.5 * DEFAULT_RATE;                  // 6.25e-6
const LONG_MULT     = 1;
const LONG_THRESH   = -(DEFAULT_RATE * LONG_MULT);         // -1.25e-5

const DEFAULT_PARAMS = {
  defaultRate:        DEFAULT_RATE,
  entryShortMultiple: SHORT_MULT,
  entryLongMultiple:  LONG_MULT,
  exitBand:           EXIT_BAND,
  maxHoldBars:        10,
  stopLossPct:        6,
};

// stopLossPct:100 disables engine stops so we isolate strategy logic
const BT_OPTS = { initialEquity: 1000, positionSizeUsd: 500, stopLossPct: 100, commissionPct: 0 };

// ── 1. Short entry conditions ─────────────────────────────────────────────────

describe("FundingExtremeStrategy — short entries", () => {
  it("fires at exactly defaultRate × entryShortMultiple", () => {
    const candles = [
      ...Array.from({ length: 5 }, (_, i) => makeCandle(i * H, DEFAULT_RATE)),
      makeCandle(5 * H, SHORT_THRESH),  // exactly at threshold → should fire
      ...Array.from({ length: 4 }, (_, i) => makeCandle((6 + i) * H, DEFAULT_RATE)),
    ];
    const result = runBacktest(new FundingExtremeStrategy(DEFAULT_PARAMS), candles, BT_OPTS);
    const entry = result.trades.find(t => t.side === "short");
    expect(entry).toBeDefined();
    expect(entry!.entryTime).toBe(5 * H);
  });

  it("does NOT fire when funding is just below the threshold", () => {
    const belowThresh = SHORT_THRESH - 1e-9;
    const candles = Array.from({ length: 20 }, (_, i) => makeCandle(i * H, belowThresh));
    const result = runBacktest(new FundingExtremeStrategy(DEFAULT_PARAMS), candles, BT_OPTS);
    expect(result.trades.filter(t => t.side === "short").length).toBe(0);
  });

  it("fires multiple times as funding spikes and normalises repeatedly", () => {
    // spike → normalise → spike → normalise
    const candles = [
      ...Array.from({ length: 3 }, (_, i) => makeCandle(i * H, DEFAULT_RATE)),
      makeCandle(3 * H, SHORT_THRESH),   // entry 1
      makeCandle(4 * H, DEFAULT_RATE),   // exit 1 (normalised)
      makeCandle(5 * H, DEFAULT_RATE),
      makeCandle(6 * H, SHORT_THRESH),   // entry 2
      makeCandle(7 * H, DEFAULT_RATE),   // exit 2 (normalised)
      makeCandle(8 * H, DEFAULT_RATE),
    ];
    const result = runBacktest(new FundingExtremeStrategy(DEFAULT_PARAMS), candles, BT_OPTS);
    expect(result.trades.filter(t => t.side === "short").length).toBe(2);
  });
});

// ── 2. Long entry conditions ──────────────────────────────────────────────────

describe("FundingExtremeStrategy — long entries", () => {
  it("fires at exactly −defaultRate × entryLongMultiple (LONG_THRESH = −1.25e-5)", () => {
    const candles = [
      ...Array.from({ length: 5 }, (_, i) => makeCandle(i * H, DEFAULT_RATE)),
      makeCandle(5 * H, LONG_THRESH),   // exactly at threshold (−1.25e-5) → should fire
      ...Array.from({ length: 4 }, (_, i) => makeCandle((6 + i) * H, DEFAULT_RATE)),
    ];
    const result = runBacktest(new FundingExtremeStrategy(DEFAULT_PARAMS), candles, BT_OPTS);
    const entry = result.trades.find(t => t.side === "long");
    expect(entry).toBeDefined();
    expect(entry!.entryTime).toBe(5 * H);
  });

  it("does NOT fire when funding is only slightly negative (above threshold)", () => {
    // −1e-6 is negative but above −1.25e-5; would be noise under any-negative rule
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle(i * H, i === 10 ? -1e-6 : DEFAULT_RATE),
    );
    const result = runBacktest(new FundingExtremeStrategy(DEFAULT_PARAMS), candles, BT_OPTS);
    expect(result.trades.filter(t => t.side === "long").length).toBe(0);
  });

  it("does NOT fire when funding is positive", () => {
    const candles = Array.from({ length: 20 }, (_, i) => makeCandle(i * H, DEFAULT_RATE));
    const result = runBacktest(new FundingExtremeStrategy(DEFAULT_PARAMS), candles, BT_OPTS);
    expect(result.trades.filter(t => t.side === "long").length).toBe(0);
  });

  it("respects custom entryLongMultiple — higher k requires more extreme negative funding", () => {
    // k_long = 2: threshold = −2.5e-5
    // −1.25e-5 > −2.5e-5 → no entry; −3e-5 ≤ −2.5e-5 → entry
    const params = { ...DEFAULT_PARAMS, entryLongMultiple: 2 };
    const candlesNoEntry = Array.from({ length: 10 }, (_, i) =>
      makeCandle(i * H, i === 5 ? -1.25e-5 : DEFAULT_RATE),
    );
    const candlesEntry = Array.from({ length: 10 }, (_, i) =>
      makeCandle(i * H, i === 5 ? -3e-5 : DEFAULT_RATE),
    );
    const rNo  = runBacktest(new FundingExtremeStrategy(params), candlesNoEntry, BT_OPTS);
    const rYes = runBacktest(new FundingExtremeStrategy(params), candlesEntry,   BT_OPTS);
    expect(rNo.trades.filter(t => t.side === "long").length).toBe(0);
    expect(rYes.trades.filter(t => t.side === "long").length).toBeGreaterThan(0);
  });
});

// ── 3. Exit conditions ────────────────────────────────────────────────────────

describe("FundingExtremeStrategy — exits", () => {
  it("normalised exit fires when |funding − defaultRate| < exitBand", () => {
    // Short entry at bar 3, funding returns to DEFAULT_RATE at bar 4 → normalised
    const candles = [
      ...Array.from({ length: 3 }, (_, i) => makeCandle(i * H, DEFAULT_RATE)),
      makeCandle(3 * H, SHORT_THRESH),   // short entry
      makeCandle(4 * H, DEFAULT_RATE),   // |DEFAULT - DEFAULT| = 0 < EXIT_BAND → exit
      makeCandle(5 * H, DEFAULT_RATE),
    ];
    const result = runBacktest(new FundingExtremeStrategy(DEFAULT_PARAMS), candles, BT_OPTS);
    const trade = result.trades.find(t => t.side === "short");
    expect(trade).toBeDefined();
    expect(trade!.reason).toMatch(/normalised/);
  });

  it("does NOT exit while funding stays outside exitBand", () => {
    // Short entry at bar 2; bar 3 still extreme; bar 4 normalises
    const candles = [
      makeCandle(0,     DEFAULT_RATE),
      makeCandle(H,     DEFAULT_RATE),
      makeCandle(2 * H, SHORT_THRESH),   // short entry
      makeCandle(3 * H, SHORT_THRESH),   // still outside band: |3.75e-5 - 1.25e-5| = 2.5e-5 > 6.25e-6
      makeCandle(4 * H, DEFAULT_RATE),   // normalised → exit
      makeCandle(5 * H, DEFAULT_RATE),
    ];
    const result = runBacktest(new FundingExtremeStrategy(DEFAULT_PARAMS), candles, BT_OPTS);
    const trade = result.trades.find(t => t.side === "short");
    expect(trade).toBeDefined();
    // exitTime is the timestamp of the bar on which the exit signal was emitted
    expect(trade!.exitTime).toBe(4 * H);
  });

  it("max-hold exit fires when funding stays extreme beyond maxHoldBars", () => {
    // Entry at bar 2; funding stays at SHORT_THRESH for 20 bars (never normalises)
    const MAX_HOLD = 10;
    const candles = [
      makeCandle(0,     DEFAULT_RATE),
      makeCandle(H,     DEFAULT_RATE),
      ...Array.from({ length: 20 }, (_, i) => makeCandle((2 + i) * H, SHORT_THRESH)),
    ];
    const result = runBacktest(
      new FundingExtremeStrategy({ ...DEFAULT_PARAMS, maxHoldBars: MAX_HOLD }),
      candles,
      BT_OPTS,
    );
    const trade = result.trades.find(t => t.side === "short");
    expect(trade).toBeDefined();
    expect(trade!.reason).toMatch(/max-hold/);
  });

  it("thresholds are pure functions of params — different multiples give different entry points", () => {
    // candle at 3×DEFAULT: fires for k=2 (threshold 2.5e-5), does NOT fire for k=5 (threshold 6.25e-5)
    const threeX = DEFAULT_RATE * 3; // 3.75e-5 — above 2× default but below 5× default
    const candles = [
      ...Array.from({ length: 5 }, (_, i) => makeCandle(i * H, DEFAULT_RATE)),
      makeCandle(5 * H, threeX),
      ...Array.from({ length: 5 }, (_, i) => makeCandle((6 + i) * H, DEFAULT_RATE)),
    ];

    const rK2 = runBacktest(
      new FundingExtremeStrategy({ ...DEFAULT_PARAMS, entryShortMultiple: 2 }),
      candles, BT_OPTS,
    );
    const rK5 = runBacktest(
      new FundingExtremeStrategy({ ...DEFAULT_PARAMS, entryShortMultiple: 5 }),
      candles, BT_OPTS,
    );

    expect(rK2.trades.filter(t => t.side === "short").length).toBeGreaterThan(0);
    expect(rK5.trades.filter(t => t.side === "short").length).toBe(0);
  });

  it("produces no trades when signal is missing on all candles", () => {
    const candles = Array.from({ length: 50 }, (_, i) => makeCandle(i * H, null));
    const result = runBacktest(new FundingExtremeStrategy(DEFAULT_PARAMS), candles, BT_OPTS);
    expect(result.tradeCount).toBe(0);
  });
});

// ── 4. Bot creation gate ─────────────────────────────────────────────────────

describe("funding-extreme requiresSignals gate", () => {
  it("is registered in STRATEGY_REGISTRY with requiresSignals=true", () => {
    const entry = STRATEGY_REGISTRY.find(e => e.id === "funding-extreme");
    expect(entry).toBeDefined();
    expect(entry!.requiresSignals).toBe(true);
    expect(entry!.isCandleStrategy).toBe(true);
    expect(entry!.factory).not.toBeNull();
  });

  it("addBot gate blocks funding-extreme in paper mode", () => {
    function simulateAddBot(strategyId: string, live: boolean): void {
      const entry = STRATEGY_REGISTRY.find(
        e => e.id === strategyId && e.isCandleStrategy && e.factory !== null,
      );
      if (!entry) throw new Error(`Unknown strategy: ${strategyId}`);
      if (entry.requiresSignals) {
        throw new Error(`"${entry.displayName}" is backtest-only`);
      }
      void live;
    }

    expect(() => simulateAddBot("funding-extreme", false)).toThrow(/backtest-only/);
    expect(() => simulateAddBot("funding-extreme", true)).toThrow(/backtest-only/);
    expect(() => simulateAddBot("confluence", false)).not.toThrow();
  });

  it("is excluded from the bots-page registry filter", () => {
    const filtered = STRATEGY_REGISTRY.filter(e => !e.requiresSignals);
    expect(filtered.find(e => e.id === "funding-extreme")).toBeUndefined();
    expect(filtered.find(e => e.id === "confluence")).toBeDefined();
  });
});
