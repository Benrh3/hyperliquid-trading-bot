import { describe, it, expect } from "vitest";
import { attachSignals } from "../backtest.js";
import type { Candle } from "../events.js";

function makeCandle(timestamp: number): Candle {
  return { timestamp, open: 100, high: 105, low: 95, close: 102, volume: 1000 };
}

describe("attachSignals — no-lookahead correctness", () => {
  it("never attaches a signal value from a future timestamp", () => {
    // Candles at 1000, 2000, 3000, 4000, 5000
    const candles = [1000, 2000, 3000, 4000, 5000].map(makeCandle);

    // Signal arrives at 2500 and 4500 — between candle boundaries
    const signalMap = new Map([
      ["test_signal", [
        { capturedAt: 2500, value: 0.7 },
        { capturedAt: 4500, value: 0.3 },
      ]],
    ]);

    attachSignals(candles, signalMap);

    // Candle at 1000: no signal data yet (2500 is in the future)
    expect(candles[0].signals!["test_signal"]).toBeNull();

    // Candle at 2000: still no signal data (2500 is still in the future)
    expect(candles[1].signals!["test_signal"]).toBeNull();

    // Candle at 3000: signal at 2500 is now visible (at-or-before 3000)
    expect(candles[2].signals!["test_signal"]).toBe(0.7);

    // Candle at 4000: still sees 2500's value (4500 is in the future)
    expect(candles[3].signals!["test_signal"]).toBe(0.7);

    // Candle at 5000: now sees 4500's value
    expect(candles[4].signals!["test_signal"]).toBe(0.3);
  });

  it("uses exact-match (at) for signal at same timestamp as candle", () => {
    const candles = [1000, 2000, 3000].map(makeCandle);

    const signalMap = new Map([
      ["exact", [{ capturedAt: 2000, value: 42 }]],
    ]);

    attachSignals(candles, signalMap);

    expect(candles[0].signals!["exact"]).toBeNull();
    // Signal at exactly 2000 is visible to candle at 2000 (at-or-before)
    expect(candles[1].signals!["exact"]).toBe(42);
    expect(candles[2].signals!["exact"]).toBe(42);
  });

  it("propagates null signal values (does not fall back to previous non-null)", () => {
    const candles = [1000, 2000, 3000, 4000].map(makeCandle);

    const signalMap = new Map([
      ["nullable", [
        { capturedAt: 500,  value: 0.5 },
        { capturedAt: 1500, value: null },  // measured but undefined
        { capturedAt: 3500, value: 0.8 },
      ]],
    ]);

    attachSignals(candles, signalMap);

    // Candle 1000: sees value from t=500
    expect(candles[0].signals!["nullable"]).toBe(0.5);

    // Candle 2000: sees null from t=1500 (NOT fallback to 0.5)
    expect(candles[1].signals!["nullable"]).toBeNull();

    // Candle 3000: still null (3500 is in the future)
    expect(candles[2].signals!["nullable"]).toBeNull();

    // Candle 4000: sees 0.8 from t=3500
    expect(candles[3].signals!["nullable"]).toBe(0.8);
  });

  it("handles multiple signals within one candle interval (last wins)", () => {
    const candles = [1000, 5000].map(makeCandle);

    // Three signal updates between candle 1000 and candle 5000
    const signalMap = new Map([
      ["rapid", [
        { capturedAt: 2000, value: 0.1 },
        { capturedAt: 3000, value: 0.2 },
        { capturedAt: 4000, value: 0.3 },
      ]],
    ]);

    attachSignals(candles, signalMap);

    expect(candles[0].signals!["rapid"]).toBeNull();
    // Candle 5000 should see the latest value (t=4000), not earlier ones
    expect(candles[1].signals!["rapid"]).toBe(0.3);
  });

  it("handles multiple signal keys independently", () => {
    const candles = [1000, 2000, 3000].map(makeCandle);

    const signalMap = new Map([
      ["signal_a", [{ capturedAt: 500, value: 10 }]],
      ["signal_b", [{ capturedAt: 2500, value: 20 }]],
    ]);

    attachSignals(candles, signalMap);

    // signal_a visible from the start, signal_b only after 2500
    expect(candles[0].signals!["signal_a"]).toBe(10);
    expect(candles[0].signals!["signal_b"]).toBeNull();

    expect(candles[1].signals!["signal_a"]).toBe(10);
    expect(candles[1].signals!["signal_b"]).toBeNull();

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
        { capturedAt: 2500, value: 1.0 },
        { capturedAt: 3500, value: null },
      ]],
    ]);

    const coverage = attachSignals(candles, signalMap);

    // Candle 1000: null (no data yet)
    // Candle 2000: null (no data yet)
    // Candle 3000: 1.0 (from t=2500) → the only non-null
    // Candle 4000: null (explicit null from t=3500)
    // Candle 5000: null (still null)
    expect(coverage).toEqual([
      { key: "partial", filled: 1, total: 5 },
    ]);
  });

  it("exhaustive no-lookahead: every attached value has capturedAt <= candle.timestamp", () => {
    // Generate a longer series with irregular signal spacing
    const candles = Array.from({ length: 100 }, (_, i) => makeCandle((i + 1) * 1000));

    const signalData = [
      { capturedAt: 500,   value: 0.1 },
      { capturedAt: 5200,  value: 0.2 },
      { capturedAt: 5300,  value: 0.3 },
      { capturedAt: 20000, value: 0.4 },
      { capturedAt: 50500, value: 0.5 },
      { capturedAt: 99999, value: 0.6 },
      { capturedAt: 100000, value: 0.7 },
    ];

    const signalMap = new Map([["exhaustive", signalData]]);
    attachSignals(candles, signalMap);

    for (const candle of candles) {
      const val = candle.signals!["exhaustive"];
      if (val === null) continue;

      // Find which signal entry produced this value
      const source = signalData.filter(
        (s) => s.value === val && s.capturedAt <= candle.timestamp,
      );
      expect(source.length).toBeGreaterThan(0);

      // Verify it's the LATEST such entry
      const latestAtOrBefore = signalData
        .filter((s) => s.capturedAt <= candle.timestamp)
        .at(-1)!;
      expect(val).toBe(latestAtOrBefore.value);
    }
  });
});
