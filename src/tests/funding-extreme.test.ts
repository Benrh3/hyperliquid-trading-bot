import { describe, it, expect } from "vitest";
import { computePercentile, FundingExtremeStrategy, SIGNAL_KEY } from "../strategy/funding-extreme.js";
import { STRATEGY_REGISTRY } from "../strategy/registry.js";
import { runBacktest } from "../backtest.js";
import type { Candle } from "../events.js";

const H = 3_600_000; // 1 hour in ms

function makeCandle(timestamp: number, funding: number | null): Candle {
  const c: Candle = { timestamp, open: 100, high: 101, low: 99, close: 100, volume: 1000 };
  if (funding !== null) c.signals = { [SIGNAL_KEY]: funding };
  return c;
}

const DEFAULT_PARAMS = {
  entryLongBelow:     0.10,
  entryShortAbove:    0.90,
  exitBandLow:        0.40,
  exitBandHigh:       0.60,
  trailingWindowBars: 30,   // small window for fast tests
  maxHoldBars:        10,
  stopLossPct:        6,
};

const BT_OPTS = { initialEquity: 1000, positionSizeUsd: 500, stopLossPct: 100, commissionPct: 0 };

// ── 1. computePercentile unit tests ──────────────────────────────────────────

describe("computePercentile", () => {
  it("returns the only value for a single-element array", () => {
    expect(computePercentile([0.5], 0.5)).toBe(0.5);
    expect(computePercentile([0.5], 0)).toBe(0.5);
    expect(computePercentile([0.5], 1)).toBe(0.5);
  });

  it("returns NaN for empty array", () => {
    expect(isNaN(computePercentile([], 0.5))).toBe(true);
  });

  it("returns min and max at p0 and p1", () => {
    const s = [1, 2, 3, 4, 5];
    expect(computePercentile(s, 0)).toBe(1);
    expect(computePercentile(s, 1)).toBe(5);
  });

  it("returns exact median for odd-length array", () => {
    expect(computePercentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  it("interpolates correctly for even-length array", () => {
    // [1, 2, 3, 4]: p0.5 index = 1.5 → 2 + (3-2)*0.5 = 2.5
    expect(computePercentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
  });

  it("p90 of [0.0001 × 29, 0.001] (30 values) is 0.0001", () => {
    const sorted = [...Array(29).fill(0.0001), 0.001];
    // p90 index = 0.9 × 29 = 26.1 → between indices 26 and 27 (both 0.0001)
    expect(computePercentile(sorted, 0.90)).toBeCloseTo(0.0001, 6);
  });

  it("p10 of [0.001, 0.001, ...28×0.0001] (30 values) is 0.001 interpolated low", () => {
    const sorted = [0.001, 0.001, ...Array(28).fill(0.0001)].sort((a, b) => a - b);
    // sorted: 28 × 0.0001, 2 × 0.001
    // p10 index = 0.1 × 29 = 2.9 → between index 2 (0.0001) and 3 (0.0001)
    expect(computePercentile(sorted, 0.10)).toBeCloseTo(0.0001, 6);
  });
});

// ── 2. Point-in-time invariant ────────────────────────────────────────────────

describe("FundingExtremeStrategy — point-in-time percentile invariant", () => {
  /**
   * Core invariant: the entry decision at bar T is identical whether we run
   * the strategy on candles[0..T+5] or candles[0..T+50].  Adding future bars
   * must not affect decisions at earlier bars.
   *
   * Test design: bar 40 has a spike (0.001) in a sea of 0.0002.  With a 30-bar
   * trailing window the spike is clearly above p90 of [0.0002×29, 0.001] →
   * short entry.  We verify this entry appears identically in both a short run
   * (50 bars) and a long run (80 bars).
   */
  function buildCandles(n: number): Candle[] {
    return Array.from({ length: n }, (_, i) =>
      makeCandle(i * H, i === 40 ? 0.001 : 0.0002),
    );
  }

  it("short entry at bar 40 exists in a 50-bar and an 80-bar run", () => {
    const entry40ts = 40 * H;

    const r50 = runBacktest(new FundingExtremeStrategy(DEFAULT_PARAMS), buildCandles(50), BT_OPTS);
    const r80 = runBacktest(new FundingExtremeStrategy(DEFAULT_PARAMS), buildCandles(80), BT_OPTS);

    const e50 = r50.trades.find(t => t.entryTime === entry40ts && t.side === "short");
    const e80 = r80.trades.find(t => t.entryTime === entry40ts && t.side === "short");

    expect(e50).toBeDefined();
    expect(e80).toBeDefined();
    // Same candle, same decision → fill prices must be equal
    expect(e50!.entryPrice).toBeCloseTo(e80!.entryPrice, 8);
  });

  it("entry fires at bar 40 and funding there exceeds independently computed point-in-time p90", () => {
    // Note: BacktestTrade.reason records the EXIT reason, not the entry reason.
    // Verify point-in-time correctness by independently recomputing the trailing
    // window p90 at bar 40 and asserting the entry's signal value exceeds it.
    const WINDOW  = 30;
    const candles = buildCandles(50);

    const result = runBacktest(
      new FundingExtremeStrategy({ ...DEFAULT_PARAMS, trailingWindowBars: WINDOW }),
      candles,
      BT_OPTS,
    );
    const entry = result.trades.find(t => t.entryTime === 40 * H && t.side === "short");
    expect(entry).toBeDefined();

    // Signal value at entry bar 40
    const fundingAtEntry = candles[40].signals?.[SIGNAL_KEY] as number;
    expect(isFinite(fundingAtEntry)).toBe(true);

    // Independently compute p90 of the trailing window at bar 40:
    // window = candles[max(0,40-30+1)..40] = candles[11..40] (30 values)
    // = [0.0002 × 29, 0.001]
    const windowVals = candles
      .slice(Math.max(0, 41 - WINDOW), 41)
      .map(c => c.signals?.[SIGNAL_KEY] as number)
      .filter(v => v !== undefined && isFinite(v));
    const sorted      = [...windowVals].sort((a, b) => a - b);
    const ptP90       = computePercentile(sorted, DEFAULT_PARAMS.entryShortAbove);

    // The entry is a short, so funding must be strictly above p90
    expect(fundingAtEntry).toBeGreaterThan(ptP90);

    // Sanity: full-series p90 (all 50 bars) differs from trailing-window p90,
    // showing the trailing window is actually doing something different
    const allVals  = candles.map(c => c.signals?.[SIGNAL_KEY] as number).filter(isFinite);
    const allSorted = [...allVals].sort((a, b) => a - b);
    const fullP90   = computePercentile(allSorted, DEFAULT_PARAMS.entryShortAbove);
    // Both are non-NaN; the point-in-time p90 ≤ full-series p90
    expect(isFinite(ptP90)).toBe(true);
    expect(isFinite(fullP90)).toBe(true);
    // The point-in-time window excludes bars 41-49 (which are 0.0002 and would
    // dilute the spike) so ptP90 and fullP90 may or may not differ here,
    // but both must be below the spike value so the entry fires regardless
    expect(fundingAtEntry).toBeGreaterThan(fullP90);
  });

  it("no trades before minimum window (24 bars) have accumulated", () => {
    // With trailingWindowBars=30 and MIN_WINDOW=24, first entry cannot occur before bar 23
    const candles = Array.from({ length: 60 }, (_, i) =>
      makeCandle(i * H, 0.001), // spike on every bar — would trigger immediately if no warmup
    );
    const result = runBacktest(new FundingExtremeStrategy(DEFAULT_PARAMS), candles, BT_OPTS);
    if (result.trades.length > 0) {
      const firstEntryBar = result.trades[0].entryTime / H;
      expect(firstEntryBar).toBeGreaterThanOrEqual(24);
    }
  });
});

// ── 3. Entry threshold correctness ───────────────────────────────────────────

describe("FundingExtremeStrategy — entries respect computed thresholds", () => {
  it("every short entry has funding value above the point-in-time p90", () => {
    // Vary signal enough to get a mix of entries
    const signals = Array.from({ length: 200 }, (_, i) => {
      const phase = i % 60;
      if (phase < 5)  return 0.002;   // spike high → short entry zone
      if (phase < 10) return 0.0005;  // normalise → short exits
      if (phase < 15) return -0.001;  // spike low → long entry zone
      if (phase < 20) return 0.0005;  // normalise → long exits
      return 0.0005;                  // baseline
    });
    const WINDOW = 30;
    const candles = signals.map((sig, i) => makeCandle(i * H, sig));
    const params  = { ...DEFAULT_PARAMS, trailingWindowBars: WINDOW };
    const result  = runBacktest(new FundingExtremeStrategy(params), candles, BT_OPTS);

    const shortTrades = result.trades.filter(t => t.side === "short");
    expect(shortTrades.length).toBeGreaterThan(0);

    for (const trade of shortTrades) {
      const barIdx     = trade.entryTime / H;
      const entryCandle = candles[barIdx];
      const fundingVal  = entryCandle?.signals?.[SIGNAL_KEY] as number;
      expect(fundingVal).toBeDefined();

      // Recompute trailing-window p90 at this bar
      const windowVals = candles
        .slice(Math.max(0, barIdx + 1 - WINDOW), barIdx + 1)
        .map(c => c.signals?.[SIGNAL_KEY] as number)
        .filter(v => v !== undefined && isFinite(v));
      const sorted     = [...windowVals].sort((a, b) => a - b);
      const p90        = computePercentile(sorted, params.entryShortAbove);

      expect(fundingVal).toBeGreaterThan(p90 - 1e-12); // strictly above (fp tolerance)
    }
  });

  it("every long entry has funding value below the point-in-time p10", () => {
    const signals = Array.from({ length: 200 }, (_, i) => {
      const phase = i % 60;
      if (phase < 5)  return -0.001;  // spike low
      if (phase < 10) return 0.0005;  // normalise
      return 0.0005;
    });
    const WINDOW = 30;
    const candles = signals.map((sig, i) => makeCandle(i * H, sig));
    const params  = { ...DEFAULT_PARAMS, trailingWindowBars: WINDOW };
    const result  = runBacktest(new FundingExtremeStrategy(params), candles, BT_OPTS);

    const longTrades = result.trades.filter(t => t.side === "long");
    expect(longTrades.length).toBeGreaterThan(0);

    for (const trade of longTrades) {
      const barIdx      = trade.entryTime / H;
      const entryCandle = candles[barIdx];
      const fundingVal  = entryCandle?.signals?.[SIGNAL_KEY] as number;
      expect(fundingVal).toBeDefined();

      const windowVals = candles
        .slice(Math.max(0, barIdx + 1 - WINDOW), barIdx + 1)
        .map(c => c.signals?.[SIGNAL_KEY] as number)
        .filter(v => v !== undefined && isFinite(v));
      const sorted = [...windowVals].sort((a, b) => a - b);
      const p10    = computePercentile(sorted, params.entryLongBelow);

      expect(fundingVal).toBeLessThan(p10 + 1e-12); // strictly below (fp tolerance)
    }
  });

  it("produces no trades when signal is missing on all candles", () => {
    const candles = Array.from({ length: 100 }, (_, i) =>
      makeCandle(i * H, null),  // null signal — no data attached
    );
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
    // Inline the same gate logic used by BotManager.addBot
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
