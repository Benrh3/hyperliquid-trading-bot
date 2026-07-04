import { describe, it, expect } from "vitest";
import { getIndicator, INDICATOR_REGISTRY } from "../strategy/indicators.js";
import { CustomStrategy } from "../strategy/custom-strategy.js";
import { customDefToRegistryEntry } from "../strategy/custom-strategy.js";
import { runBacktest, attachSignals } from "../backtest.js";
import type { Candle } from "../events.js";
import type { CustomStrategyDef } from "../strategy/custom-strategy.js";

function makeCandle(timestamp: number, close = 100): Candle {
  return { timestamp, open: close, high: close + 2, low: close - 2, close, volume: 1000 };
}

// ── 1. Market Signal entries exist in the registry ────────────────────────────

describe("Market Signal indicator registry", () => {
  it("generates signal:* entries for all signalForScoring metrics", () => {
    const signalEntries = INDICATOR_REGISTRY.filter(m => m.category === "Market Signal");
    // Manifest has 39 scoring signals — expect at least a few
    expect(signalEntries.length).toBeGreaterThanOrEqual(5);
    // Every entry id must be prefixed signal:
    for (const e of signalEntries) {
      expect(e.id).toMatch(/^signal:/);
    }
  });

  it("lsr_agg_long_frac is registered as signal:lsr_agg_long_frac", () => {
    const entry = getIndicator("signal:lsr_agg_long_frac");
    expect(entry).toBeDefined();
    expect(entry!.category).toBe("Market Signal");
    expect(entry!.outputKeys).toEqual(["values"]);
    expect(entry!.defaultParams).toEqual([]);
  });

  it("signal fn returns NaN when candle has no signal data", () => {
    const entry = getIndicator("signal:lsr_agg_long_frac")!;
    const candles = [makeCandle(1000), makeCandle(2000)];
    // No signals attached
    const result = entry.fn(candles, {});
    expect(result.values).toHaveLength(2);
    expect(result.values.every(v => isNaN(v))).toBe(true);
  });

  it("signal fn reads candle.signals[key] when attached", () => {
    const entry = getIndicator("signal:lsr_agg_long_frac")!;
    const candles = [makeCandle(1000), makeCandle(2000), makeCandle(3000)];
    // Attach signals manually (simulating attachSignals)
    candles[0].signals = { lsr_agg_long_frac: 0.4 };
    candles[1].signals = { lsr_agg_long_frac: 0.6 };
    candles[2].signals = { lsr_agg_long_frac: null };

    const result = entry.fn(candles, {});
    expect(result.values[0]).toBe(0.4);
    expect(result.values[1]).toBe(0.6);
    expect(isNaN(result.values[2])).toBe(true); // null → NaN
  });
});

// ── 2. Signal conditions drive entries/exits correctly ────────────────────────

describe("Builder strategy with signal conditions — backtest integration", () => {
  it("enters long when lsr_agg_long_frac > 0.55 and exits when < 0.45", () => {
    const def: CustomStrategyDef = {
      id:   "custom-test-signal",
      name: "Test Signal Strategy",
      description: "",
      entryLongRules: [{
        id: "r0", indicatorId: "signal:lsr_agg_long_frac",
        params: {}, outputKey: "values",
        comparator: ">", rhsType: "value", rhsValue: 0.55, rhsPriceKey: "close",
      }],
      entryShortRules: [],
      exitRules: [{
        id: "r1", indicatorId: "signal:lsr_agg_long_frac",
        params: {}, outputKey: "values",
        comparator: "<", rhsType: "value", rhsValue: 0.45, rhsPriceKey: "close",
      }],
      entryLogic: "AND",
      exitLogic:  "AND",
      stopLoss:   99,  // very high — won't trigger
      takeProfit: 0,
      isCustom:   true,
    };

    const strategy = new CustomStrategy(def);

    // 60 candles with enough history to pass the 35-bar minimum
    const candles: Candle[] = Array.from({ length: 60 }, (_, i) =>
      makeCandle((i + 1) * 3_600_000, 100),
    );

    // Attach signal: weak (no entry) for first 40, strong for 41-50, weak again 51+
    const signalSeries = [
      { capturedAt: 0, value: 0.40 },          // candles 1-40: no entry
      { capturedAt: 41 * 3_600_000, value: 0.60 }, // candle 41+: should enter
      { capturedAt: 52 * 3_600_000, value: 0.40 }, // candle 52+: should exit
    ];
    attachSignals(candles, new Map([["lsr_agg_long_frac", signalSeries]]));

    const result = runBacktest(strategy, candles, {
      initialEquity: 1000, positionSizeUsd: 500, stopLossPct: 99, commissionPct: 0,
    });

    // Should have made at least one trade (entry at 41, exit at 52)
    expect(result.tradeCount).toBeGreaterThanOrEqual(1);
    const trade = result.trades[0];
    expect(trade.side).toBe("long");
  });

  it("never trades when signals are all NaN (no attachment)", () => {
    const def: CustomStrategyDef = {
      id: "custom-no-signal", name: "No Signal", description: "",
      entryLongRules: [{
        id: "r0", indicatorId: "signal:lsr_agg_long_frac",
        params: {}, outputKey: "values",
        comparator: ">", rhsType: "value", rhsValue: 0.55, rhsPriceKey: "close",
      }],
      entryShortRules: [], exitRules: [],
      entryLogic: "AND", exitLogic: "AND",
      stopLoss: 2, takeProfit: 0, isCustom: true,
    };
    const strategy = new CustomStrategy(def);
    const candles = Array.from({ length: 50 }, (_, i) => makeCandle((i + 1) * 3_600_000));
    // No attachSignals call → signals are undefined → NaN → no entries
    const result = runBacktest(strategy, candles, {
      initialEquity: 1000, positionSizeUsd: 500, stopLossPct: 2, commissionPct: 0,
    });
    expect(result.tradeCount).toBe(0);
  });
});

// ── 3. requiresSignals derivation ─────────────────────────────────────────────

describe("requiresSignals flag", () => {
  it("is false for a strategy with only OHLCV indicators", () => {
    const def: CustomStrategyDef = {
      id: "custom-ohlcv", name: "OHLCV Only", description: "",
      entryLongRules: [{
        id: "r0", indicatorId: "RSI", params: { period: 14 }, outputKey: "values",
        comparator: "<", rhsType: "value", rhsValue: 30, rhsPriceKey: "close",
      }],
      entryShortRules: [], exitRules: [],
      entryLogic: "AND", exitLogic: "AND",
      stopLoss: 2, takeProfit: 0, isCustom: true,
    };
    const entry = customDefToRegistryEntry(def);
    expect(entry.requiresSignals).toBe(false);
  });

  it("is true when any rule uses a signal: indicator", () => {
    const def: CustomStrategyDef = {
      id: "custom-mixed", name: "Mixed", description: "",
      entryLongRules: [
        {
          id: "r0", indicatorId: "RSI", params: { period: 14 }, outputKey: "values",
          comparator: "<", rhsType: "value", rhsValue: 30, rhsPriceKey: "close",
        },
        {
          id: "r1", indicatorId: "signal:lsr_agg_long_frac", params: {}, outputKey: "values",
          comparator: ">", rhsType: "value", rhsValue: 0.55, rhsPriceKey: "close",
        },
      ],
      entryShortRules: [], exitRules: [],
      entryLogic: "AND", exitLogic: "AND",
      stopLoss: 2, takeProfit: 0, isCustom: true,
    };
    const entry = customDefToRegistryEntry(def);
    expect(entry.requiresSignals).toBe(true);
    expect(entry.categoryLabel).toContain("Backtest Only");
  });

  it("is true when signal is only in exit rules", () => {
    const def: CustomStrategyDef = {
      id: "custom-sig-exit", name: "Signal Exit", description: "",
      entryLongRules: [{
        id: "r0", indicatorId: "RSI", params: { period: 14 }, outputKey: "values",
        comparator: "<", rhsType: "value", rhsValue: 30, rhsPriceKey: "close",
      }],
      entryShortRules: [],
      exitRules: [{
        id: "r1", indicatorId: "signal:funding_rate", params: {}, outputKey: "values",
        comparator: ">", rhsType: "value", rhsValue: 0.01, rhsPriceKey: "close",
      }],
      entryLogic: "AND", exitLogic: "AND",
      stopLoss: 2, takeProfit: 0, isCustom: true,
    };
    const entry = customDefToRegistryEntry(def);
    expect(entry.requiresSignals).toBe(true);
  });
});
