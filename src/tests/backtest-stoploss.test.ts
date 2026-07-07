import { describe, it, expect } from "vitest";
import { runBacktest, resolveEffectiveStop } from "../backtest.js";
import type { Candle } from "../events.js";

const H = 3_600_000;

// ── helpers ───────────────────────────────────────────────────────────────────

function bar(ts: number, o: number, h: number, l: number, c: number): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: 1000 };
}

// Strategy that immediately goes long on bar 0 and never emits another signal
// (so we can observe engine stop-loss behaviour in isolation).
const longAndHoldStrategy = {
  name: "long-and-hold",
  opened: false,
  onCandle(candle: Candle, _history: Candle[]) {
    if (!this.opened) { this.opened = true; return { side: "long" as const, coin: "TEST", reason: "open", timestamp: 0 }; }
    return null;
  },
  getState() { return {}; },
};

function freshLong() {
  return { ...longAndHoldStrategy, opened: false };
}

// ── 1. resolveEffectiveStop: unit tests ──────────────────────────────────────

describe("resolveEffectiveStop", () => {
  const paramsWithStop = [
    { key: "entryLongBelow",  default: 0.10 },
    { key: "stopLossPct",     default: 6    },
    { key: "maxHoldBars",     default: 72   },
  ];
  const paramsWithoutStop = [
    { key: "minConfluence",   default: 3    },
    { key: "rsiPeriod",       default: 14   },
  ];

  it("strategy with own stopLossPct param: param value wins over general", () => {
    // User set the param to 8 in the UI; general stop is 2.
    expect(resolveEffectiveStop(paramsWithStop, { stopLossPct: 8 }, 2)).toBe(8);
  });

  it("strategy with own stopLossPct param: param default used when not in mergedParams", () => {
    // mergedParams hasn't been overridden → falls back to param default (6), not general (2)
    expect(resolveEffectiveStop(paramsWithStop, {}, 2)).toBe(6);
  });

  it("strategy without stopLossPct param: general stop applies", () => {
    expect(resolveEffectiveStop(paramsWithoutStop, {}, 2)).toBe(2);
    expect(resolveEffectiveStop(paramsWithoutStop, { rsiPeriod: 20 }, 5)).toBe(5);
  });

  it("general stop is ignored when strategy has its own, regardless of general value", () => {
    expect(resolveEffectiveStop(paramsWithStop, { stopLossPct: 6 }, 99)).toBe(6);
    expect(resolveEffectiveStop(paramsWithStop, { stopLossPct: 6 }, 0.5)).toBe(6);
  });
});

// ── 2. Engine respects the stop level it receives ────────────────────────────

describe("runBacktest stop-loss level", () => {
  /**
   * Candle series: open long at bar 0 → bar 1 has a severe wick down (−10%).
   * With stopLossPct=2  the stop must trigger.
   * With stopLossPct=15 the stop must NOT trigger (wick < 15%).
   */
  const ENTRY_PRICE = 100;
  const candles: Candle[] = [
    // bar 0: entry candle — no wick breach on this bar
    bar(0,       ENTRY_PRICE, 101, 99, 100),
    // bar 1: fill on next open (same price for simplicity); wick drops 10%
    bar(1 * H,   ENTRY_PRICE, 101, 90, 100),
    // bar 2: close-out
    bar(2 * H,   100, 101, 99, 100),
  ];

  it("stop at 2% triggers on a −10% wick", () => {
    const result = runBacktest(freshLong(), candles, { stopLossPct: 2, commissionPct: 0 });
    const stopped = result.trades.find(t => t.reason.startsWith("Stop-loss"));
    expect(stopped).toBeDefined();
  });

  it("stop at 15% does NOT trigger on a −10% wick", () => {
    const result = runBacktest(freshLong(), candles, { stopLossPct: 15, commissionPct: 0 });
    const stopped = result.trades.find(t => t.reason.startsWith("Stop-loss"));
    expect(stopped).toBeUndefined();
  });

  it("a 6% strategy stop overrides the 2% general stop in engine options", () => {
    // Simulates what the route does: engine receives effectiveStopLossPct, not generalStop
    const wickDropPct = 4; // 4% wick — triggers 2% stop but NOT 6% stop
    const lo = ENTRY_PRICE * (1 - wickDropPct / 100);
    const c2: Candle[] = [
      bar(0,     ENTRY_PRICE, 101, 99, 100),
      bar(1 * H, ENTRY_PRICE, 101, lo, 100),
      bar(2 * H, 100, 101, 99, 100),
    ];

    // With general stop (2%): triggers
    const r2 = runBacktest(freshLong(), c2, { stopLossPct: 2,  commissionPct: 0 });
    expect(r2.trades.find(t => t.reason.startsWith("Stop-loss"))).toBeDefined();

    // With strategy stop (6%): does not trigger
    const r6 = runBacktest(freshLong(), c2, { stopLossPct: 6, commissionPct: 0 });
    expect(r6.trades.find(t => t.reason.startsWith("Stop-loss"))).toBeUndefined();
  });
});

// ── 3. Reason string matches realized P&L ────────────────────────────────────

describe("stop-loss reason matches realized P&L", () => {
  const ENTRY_PRICE = 200;
  const STOP_PCT    = 5;   // 5% stop
  const SLIPPAGE    = 0.0005;

  // Bar 1 has a wick deep enough to trigger the 5% stop
  const candles: Candle[] = [
    bar(0,       ENTRY_PRICE, 201, 199, 200),
    bar(1 * H,   ENTRY_PRICE, 201, 180, 200),  // −10% wick, well past 5% stop
    bar(2 * H,   200, 201, 199, 200),
  ];

  it("reason format is 'Stop-loss −X.XX%'", () => {
    const result = runBacktest(freshLong(), candles, { stopLossPct: STOP_PCT, commissionPct: 0 });
    const trade = result.trades.find(t => t.reason.startsWith("Stop-loss"));
    expect(trade).toBeDefined();
    expect(trade!.reason).toMatch(/^Stop-loss −\d+\.\d+%$/);
  });

  it("reported fill-loss percentage matches realized pnl to rounding", () => {
    const result = runBacktest(freshLong(), candles, { stopLossPct: STOP_PCT, commissionPct: 0 });
    const trade  = result.trades.find(t => t.reason.startsWith("Stop-loss"));
    expect(trade).toBeDefined();

    // Parse fill-loss% from reason string: "Stop-loss −5.05%"
    const match = trade!.reason.match(/−([\d.]+)%/);
    expect(match).not.toBeNull();
    const reportedLossPct = parseFloat(match![1]);

    // Ground-truth: compute fill loss from the actual trade fill prices.
    // trade.entryPrice includes entry slippage; trade.exitPrice is the stop fill.
    // The reason string rounds to 2dp, so match to 2dp precision.
    const fillLossPct = Math.abs(trade!.exitPrice - trade!.entryPrice) / trade!.entryPrice * 100;
    expect(reportedLossPct).toBeCloseTo(fillLossPct, 2);

    // Realized rawPnl from the trade record (commission=0 so pnl = rawPnl):
    // Use the unrounded fillLossPct (from trade prices) so 2dp rounding in the
    // reason string doesn't introduce a $0.01 discrepancy at $500 position size.
    const impliedRawLoss = fillLossPct / 100 * trade!.entryPrice * trade!.size;
    expect(Math.abs(trade!.pnl)).toBeCloseTo(impliedRawLoss, 6);
  });

  it("fill-loss in reason is materially less than the wick exceedance", () => {
    // The wick drops 10% but the stop fills at ~5% — the two must be materially different
    const result = runBacktest(freshLong(), candles, { stopLossPct: STOP_PCT, commissionPct: 0 });
    const trade  = result.trades.find(t => t.reason.startsWith("Stop-loss"));
    const match  = trade!.reason.match(/−([\d.]+)%/);
    const reportedLoss = parseFloat(match![1]);
    expect(reportedLoss).toBeLessThan(7);   // not the 10% wick
    expect(reportedLoss).toBeGreaterThan(4); // close to the 5% configured stop
  });
});
