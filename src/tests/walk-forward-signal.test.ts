/**
 * Tests that the walk-forward fix works: signals attached to allCandles before slicing
 * survive into IS and OOS windows (JavaScript slice preserves object references).
 *
 * We simulate what the route does:
 *   1. Build a full candle array
 *   2. Call attachSignals on it (as the fixed route does)
 *   3. Slice into IS and OOS segments
 *   4. Run runBacktest on each — verify trades fire in both
 *
 * A companion test confirms that without attachment, zero trades fire.
 */
import { describe, it, expect } from "vitest";
import { runBacktest, attachSignals } from "../backtest.js";
import { FundingExtremeStrategy } from "../strategy/funding-extreme.js";
import type { Candle } from "../events.js";

const H = 3_600_000;
const SIGNAL_KEY = "funding_rate";

// Baseline rate used by FundingExtremeStrategy default params
const DEFAULT_RATE = 0.0000125;
// A spike of 5× default triggers a short entry (entryShortMultiple default = 3)
const HIGH_RATE = DEFAULT_RATE * 5;
// Neutral rate (exits when |rate - default| < exitBand)
const NEUTRAL_RATE = DEFAULT_RATE;

/**
 * Build a synthetic candle array long enough for a walk-forward split.
 * Price is flat (100) so all P&L is funding-driven.
 * Every candle with an even index spikes funding; odd index is neutral.
 * This guarantees the strategy sees actionable signals in both IS and OOS halves.
 */
function buildCandles(count: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      timestamp: i * H,
      open: 100, high: 101, low: 99, close: 100,
      volume: 1000,
      // No signals yet — attachSignals will fill these
    });
  }
  return out;
}

/** Build a signal series where every even-index hour spikes */
function buildSignalSeries(count: number): { capturedAt: number; value: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    capturedAt: i * H + H / 2, // mid-bar so at-or-before-close alignment picks it up
    value: i % 2 === 0 ? HIGH_RATE : NEUTRAL_RATE,
  }));
}

const BT_OPTS = {
  initialEquity:  1_000,
  positionSizeUsd: 500,
  stopLossPct:    100,   // disable engine stops; let strategy exit naturally
  commissionPct:   0,
};

const STRAT_PARAMS = {
  defaultRate:        DEFAULT_RATE,
  entryShortMultiple: 3,
  entryLongMultiple:  1,
  exitBand:           DEFAULT_RATE * 0.5,
  maxHoldBars:        72,
  stopLossPct:        100,
};

function makeStrat() { return new FundingExtremeStrategy(STRAT_PARAMS); }

describe("walk-forward signal attachment — signals survive slicing", () => {
  it("signals are present on candles after slicing the attached array", () => {
    const candles = buildCandles(100);
    const signalSeries = buildSignalSeries(100);
    const signalMap = new Map([[SIGNAL_KEY, signalSeries]]);

    attachSignals(candles, signalMap);

    // Simulate IS/OOS split at index 60/40
    const is  = candles.slice(0, 60);
    const oos = candles.slice(60);

    // Every candle should carry the signals key (attachSignals writes all candles)
    expect(is.every(c => c.signals?.[SIGNAL_KEY] !== undefined)).toBe(true);
    expect(oos.every(c => c.signals?.[SIGNAL_KEY] !== undefined)).toBe(true);
  });

  it("FundingExtreme produces trades on IS segment when signals are pre-attached", () => {
    const candles = buildCandles(200);
    const signalSeries = buildSignalSeries(200);
    attachSignals(candles, new Map([[SIGNAL_KEY, signalSeries]]));

    const isCandles = candles.slice(0, 100);
    const strat = makeStrat();
    const result = runBacktest(strat, isCandles, BT_OPTS);
    expect(result.tradeCount).toBeGreaterThan(0);
  });

  it("FundingExtreme produces trades on OOS segment when signals are pre-attached", () => {
    const candles = buildCandles(200);
    const signalSeries = buildSignalSeries(200);
    attachSignals(candles, new Map([[SIGNAL_KEY, signalSeries]]));

    const oosCandles = candles.slice(100);
    const strat = makeStrat();
    const result = runBacktest(strat, oosCandles, BT_OPTS);
    expect(result.tradeCount).toBeGreaterThan(0);
  });

  it("FundingExtreme produces ZERO trades when signals are NOT attached (pre-fix behaviour)", () => {
    const candles = buildCandles(200);
    // Deliberately skip attachSignals — simulates the broken walk-forward route

    const isCandles = candles.slice(0, 100);
    const strat = makeStrat();
    const result = runBacktest(strat, isCandles, BT_OPTS);
    expect(result.tradeCount).toBe(0);
  });

  it("slice references the same candle objects (not copies) — mutations on allCandles show in slice", () => {
    const candles = buildCandles(20);
    const slice = candles.slice(5, 15);

    // Attach signals to the full array after slicing to confirm shared references
    const signalSeries = buildSignalSeries(20);
    attachSignals(candles, new Map([[SIGNAL_KEY, signalSeries]]));

    // slice[0] is candles[5] — same object, so signals are visible through the slice
    expect(slice[0].signals?.[SIGNAL_KEY]).toBeDefined();
    expect(slice[0]).toBe(candles[5]);
  });
});

describe("walk-forward signal coverage counting", () => {
  it("counts correctly when all candles have a signal key", () => {
    const candles = buildCandles(50);
    attachSignals(candles, new Map([[SIGNAL_KEY, buildSignalSeries(50)]]));

    const countFilled = (arr: Candle[]) =>
      arr.filter(c => c.signals !== undefined && Object.keys(c.signals).length > 0).length;

    expect(countFilled(candles)).toBe(50);
    expect(countFilled(candles.slice(0, 30))).toBe(30);
    expect(countFilled(candles.slice(30))).toBe(20);
  });

  it("counts zero when signals are not attached", () => {
    const candles = buildCandles(50);

    const countFilled = (arr: Candle[]) =>
      arr.filter(c => c.signals !== undefined && Object.keys(c.signals).length > 0).length;

    expect(countFilled(candles)).toBe(0);
    expect(countFilled(candles.slice(0, 30))).toBe(0);
  });

  it("returns 0 coverage when attachSignals finds no matching series in the map", () => {
    const candles = buildCandles(20);
    // Empty map — no signals to attach
    const coverage = attachSignals(candles, new Map());
    expect(coverage).toEqual([]);
    expect(candles.every(c => c.signals === undefined)).toBe(true);
  });
});
