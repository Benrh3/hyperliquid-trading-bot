/**
 * attachSignals correctness tests.
 *
 * Cutoff semantics: a signal published at capturedAt is visible to candle[i]
 * if capturedAt <= candle[i].closeTime, where closeTime = candles[i+1].timestamp
 * (inferred from the next bar's open). This matches when the strategy actually
 * decides — after the bar closes, not at the bar's open.
 *
 * Test candles use interval = 1000ms (timestamps 1000..5000), so:
 *   candle 1000 closeTime = 2000
 *   candle 2000 closeTime = 3000
 *   candle 3000 closeTime = 4000
 *   candle 4000 closeTime = 5000
 *   candle 5000 closeTime = 6000 (inferred: 5000 + 1000)
 */

import { describe, it, expect } from "vitest";
import { attachSignals } from "../backtest.js";
import type { Candle } from "../events.js";

function makeCandle(timestamp: number): Candle {
  return { timestamp, open: 100, high: 105, low: 95, close: 102, volume: 1000 };
}

describe("attachSignals — no-lookahead correctness", () => {
  it("signal between bar open and bar close is visible at that bar's close", () => {
    // Candles at 1000, 2000, 3000, 4000, 5000 (interval=1000)
    const candles = [1000, 2000, 3000, 4000, 5000].map(makeCandle);

    // Signal at 2500 arrives mid-bar (between open 2000 and close 3000 of candle 2000)
    // Signal at 4500 arrives mid-bar (between open 4000 and close 5000 of candle 4000)
    const signalMap = new Map([
      ["test_signal", [
        { capturedAt: 2500, value: 0.7 },
        { capturedAt: 4500, value: 0.3 },
      ]],
    ]);

    attachSignals(candles, signalMap);

    // Candle 1000 (closeTime 2000): 2500 > 2000 → not yet visible → null
    expect(candles[0].signals!["test_signal"]).toBeNull();

    // Candle 2000 (closeTime 3000): 2500 ≤ 3000 → visible (arrived during this bar)
    expect(candles[1].signals!["test_signal"]).toBe(0.7);

    // Candle 3000 (closeTime 4000): 4500 > 4000 → still seeing 0.7
    expect(candles[2].signals!["test_signal"]).toBe(0.7);

    // Candle 4000 (closeTime 5000): 4500 ≤ 5000 → visible
    expect(candles[3].signals!["test_signal"]).toBe(0.3);

    // Candle 5000 (closeTime 6000): 4500 ≤ 6000 → still 0.3
    expect(candles[4].signals!["test_signal"]).toBe(0.3);
  });

  it("signal at exact close time of a bar is visible to that bar", () => {
    const candles = [1000, 2000, 3000].map(makeCandle);

    // capturedAt=2000 is exactly the close time of candle 1000 (next open = 2000)
    const signalMap = new Map([
      ["exact", [{ capturedAt: 2000, value: 42 }]],
    ]);

    attachSignals(candles, signalMap);

    // Candle 1000 (closeTime 2000): 2000 ≤ 2000 → visible at close
    expect(candles[0].signals!["exact"]).toBe(42);

    // Candle 2000 (closeTime 3000): still visible
    expect(candles[1].signals!["exact"]).toBe(42);

    // Candle 3000 (closeTime 4000): still visible
    expect(candles[2].signals!["exact"]).toBe(42);
  });

  it("propagates null signal values (does not fall back to previous non-null)", () => {
    const candles = [1000, 2000, 3000, 4000].map(makeCandle);

    const signalMap = new Map([
      ["nullable", [
        { capturedAt: 500,  value: 0.5 },
        { capturedAt: 1500, value: null },  // measured but undefined; arrives before close of 1000
        { capturedAt: 3500, value: 0.8 },
      ]],
    ]);

    attachSignals(candles, signalMap);

    // Candle 1000 (closeTime 2000): 500→0.5 and 1500→null both ≤ 2000.
    // Most recent is 1500→null. Null propagates — does NOT fall back to 0.5.
    expect(candles[0].signals!["nullable"]).toBeNull();

    // Candle 2000 (closeTime 3000): 3500 > 3000 → still null from 1500
    expect(candles[1].signals!["nullable"]).toBeNull();

    // Candle 3000 (closeTime 4000): 3500 ≤ 4000 → 0.8
    expect(candles[2].signals!["nullable"]).toBe(0.8);

    // Candle 4000 (closeTime 5000): still 0.8
    expect(candles[3].signals!["nullable"]).toBe(0.8);
  });

  it("multiple signals within one candle interval: latest at-or-before close wins", () => {
    const candles = [1000, 5000].map(makeCandle);

    // Three signal updates between candle opens 1000 and 5000 (interval = 4000)
    // Candle 1000 closeTime = 5000; all three are ≤ 5000 → all visible; last wins.
    const signalMap = new Map([
      ["rapid", [
        { capturedAt: 2000, value: 0.1 },
        { capturedAt: 3000, value: 0.2 },
        { capturedAt: 4000, value: 0.3 },
      ]],
    ]);

    attachSignals(candles, signalMap);

    // Candle 1000 (closeTime 5000): all three capturedAt ≤ 5000 → last wins = 0.3
    expect(candles[0].signals!["rapid"]).toBe(0.3);

    // Candle 5000 (closeTime 9000): still 0.3
    expect(candles[1].signals!["rapid"]).toBe(0.3);
  });

  it("multiple signal keys are independent", () => {
    const candles = [1000, 2000, 3000].map(makeCandle);

    const signalMap = new Map([
      ["signal_a", [{ capturedAt: 500,  value: 10 }]],
      ["signal_b", [{ capturedAt: 2500, value: 20 }]],
    ]);

    attachSignals(candles, signalMap);

    // signal_a visible from candle 1000 (500 ≤ closeTime 2000)
    // signal_b not yet visible at candle 1000 (2500 > closeTime 2000)
    expect(candles[0].signals!["signal_a"]).toBe(10);
    expect(candles[0].signals!["signal_b"]).toBeNull();

    // signal_b visible at candle 2000 (2500 ≤ closeTime 3000)
    expect(candles[1].signals!["signal_a"]).toBe(10);
    expect(candles[1].signals!["signal_b"]).toBe(20);

    // Both visible at candle 3000
    expect(candles[2].signals!["signal_a"]).toBe(10);
    expect(candles[2].signals!["signal_b"]).toBe(20);
  });

  it("returns empty coverage when no signals provided", () => {
    const candles = [1000, 2000].map(makeCandle);
    const coverage = attachSignals(candles, new Map());
    expect(coverage).toEqual([]);
    expect(candles[0].signals).toBeUndefined();
  });

  it("returns accurate coverage metadata", () => {
    const candles = [1000, 2000, 3000, 4000, 5000].map(makeCandle);

    const signalMap = new Map([
      ["partial", [
        { capturedAt: 2500, value: 1.0 },   // visible from candle 2000 (closeTime 3000)
        { capturedAt: 3500, value: null },   // null — visible from candle 3000 (closeTime 4000)
      ]],
    ]);

    const coverage = attachSignals(candles, signalMap);

    // Candle 1000 (closeTime 2000): 2500 > 2000 → null
    // Candle 2000 (closeTime 3000): 2500 ≤ 3000 → 1.0 → filled
    // Candle 3000 (closeTime 4000): 3500 ≤ 4000 → null → not filled
    // Candle 4000 (closeTime 5000): still null → not filled
    // Candle 5000 (closeTime 6000): still null → not filled
    expect(coverage).toEqual([
      { key: "partial", filled: 1, total: 5 },
    ]);
  });

  it("exhaustive: every attached non-null value has capturedAt <= bar close time", () => {
    const candles = Array.from({ length: 100 }, (_, i) => makeCandle((i + 1) * 1000));
    // inferredInterval = 1000; closeTime[i] = candles[i+1].timestamp = (i+2)*1000 for i<99;
    // closeTime[99] = 100*1000 + 1000 = 101000

    const signalData = [
      { capturedAt: 500,    value: 0.1 },
      { capturedAt: 5200,   value: 0.2 },
      { capturedAt: 5300,   value: 0.3 },
      { capturedAt: 20000,  value: 0.4 },
      { capturedAt: 50500,  value: 0.5 },
      { capturedAt: 99999,  value: 0.6 },
      { capturedAt: 100000, value: 0.7 },
    ];

    const signalMap = new Map([["exhaustive", signalData]]);
    attachSignals(candles, signalMap);

    const interval = 1000;
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const closeTime = candles[i + 1]?.timestamp ?? (candle.timestamp + interval);
      const val = candle.signals!["exhaustive"];
      if (val === null) continue;

      // Find which signal entry produced this value — must have capturedAt ≤ closeTime
      const source = signalData.filter(
        (s) => s.value === val && s.capturedAt <= closeTime,
      );
      expect(source.length).toBeGreaterThan(0);

      // And it must be the LATEST such entry
      const latestAtOrBeforeClose = signalData
        .filter((s) => s.capturedAt <= closeTime)
        .at(-1)!;
      expect(val).toBe(latestAtOrBeforeClose.value);
    }
  });
});
