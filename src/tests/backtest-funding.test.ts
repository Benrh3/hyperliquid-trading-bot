import { describe, it, expect } from "vitest";
import { runBacktest } from "../backtest.js";
import type { Candle } from "../events.js";

const H = 3_600_000; // 1 hour in ms
const FUNDING_KEY = "funding_rate";

// ── Helpers ───────────────────────────────────────────────────────────────────

function bar(ts: number, price: number, funding: number | null = null): Candle {
  const c: Candle = { timestamp: ts, open: price, high: price, low: price, close: price, volume: 1000 };
  if (funding !== null) c.signals = { [FUNDING_KEY]: funding };
  return c;
}

// Open short on bar 0, close when barIdx === closeIdx
function shortUntil(closeIdx: number) {
  let entered = false;
  return {
    name: "test",
    onCandle(_candle: Candle, history: Candle[]) {
      const barIdx = history.length - 1;
      if (!entered) { entered = true; return { side: "short" as const, coin: "T", reason: "open", timestamp: 0 }; }
      if (barIdx === closeIdx) return { side: "close" as const, coin: "T", reason: "close", timestamp: 0 };
      return null;
    },
    getState() { return {}; },
  };
}

// Open long on bar 0, close when barIdx === closeIdx
function longUntil(closeIdx: number) {
  let entered = false;
  return {
    name: "test",
    onCandle(_candle: Candle, history: Candle[]) {
      const barIdx = history.length - 1;
      if (!entered) { entered = true; return { side: "long" as const, coin: "T", reason: "open", timestamp: 0 }; }
      if (barIdx === closeIdx) return { side: "close" as const, coin: "T", reason: "close", timestamp: 0 };
      return null;
    },
    getState() { return {}; },
  };
}

// stopLossPct:100 disables engine stops; commissionPct:0 keeps maths clean
const BT_OPTS = { initialEquity: 10_000, positionSizeUsd: 500, stopLossPct: 100, commissionPct: 0 };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("backtest funding accrual", () => {
  it("short at positive funding accrues notional × rate × bars (receives carry)", () => {
    // Position opened bar 0 (fills at bar 1 open), held bars 1..N, closed bar N.
    // Notional = entryPrice × size = positionSizeUsd = 500 (slippage cancels exactly).
    const N = 3;
    const RATE = 1e-3; // round number — per bar
    const PRICE = 100;

    const candles = [
      bar(0,         PRICE),                                                   // entry signal
      ...Array.from({ length: N }, (_, i) => bar((1 + i) * H, PRICE, RATE)), // position open, funding present
      bar((N + 1) * H, PRICE),                                                 // close fill bar
    ];

    const result = runBacktest(shortUntil(N), candles, BT_OPTS);
    const trade = result.trades.find(t => t.side === "short");
    expect(trade).toBeDefined();

    // Short receives positive funding → fundingPnl > 0
    const expectedFunding = N * 500 * RATE; // direction=+1 for short
    expect(trade!.fundingPnl).toBeCloseTo(expectedFunding, 10);
    expect(trade!.fundingPnl).toBeGreaterThan(0);
  });

  it("long at positive funding accrues negative (pays carry)", () => {
    const N = 3;
    const RATE = 1e-3;
    const PRICE = 100;

    const candles = [
      bar(0,         PRICE),
      ...Array.from({ length: N }, (_, i) => bar((1 + i) * H, PRICE, RATE)),
      bar((N + 1) * H, PRICE),
    ];

    const result = runBacktest(longUntil(N), candles, BT_OPTS);
    const trade = result.trades.find(t => t.side === "long");
    expect(trade).toBeDefined();

    // Long pays positive funding → fundingPnl < 0
    const expectedFunding = -(N * 500 * RATE); // direction=-1 for long
    expect(trade!.fundingPnl).toBeCloseTo(expectedFunding, 10);
    expect(trade!.fundingPnl).toBeLessThan(0);
  });

  it("signs flip for negative funding: short pays, long receives", () => {
    const N = 2;
    const RATE = -1e-3; // negative funding
    const PRICE = 100;

    const candles = [
      bar(0,         PRICE),
      ...Array.from({ length: N }, (_, i) => bar((1 + i) * H, PRICE, RATE)),
      bar((N + 1) * H, PRICE),
    ];

    const rShort = runBacktest(shortUntil(N), candles, BT_OPTS);
    const rLong  = runBacktest(longUntil(N),  candles, BT_OPTS);

    // Short pays negative funding → fundingPnl < 0
    expect(rShort.trades[0].fundingPnl).toBeLessThan(0);
    // Long receives negative funding → fundingPnl > 0
    expect(rLong.trades[0].fundingPnl).toBeGreaterThan(0);
  });

  it("candle without funding signal accrues nothing", () => {
    const PRICE = 100;
    // No signals on any candle
    const candles = [
      bar(0,     PRICE),
      bar(H,     PRICE),
      bar(2 * H, PRICE),
      bar(3 * H, PRICE),
    ];

    const result = runBacktest(shortUntil(2), candles, BT_OPTS);
    const trade = result.trades.find(t => t.side === "short");
    expect(trade).toBeDefined();
    expect(trade!.fundingPnl).toBe(0);
  });

  it("trade.pnl === trade.pricePnl + trade.fundingPnl exactly", () => {
    // Mix of price move and funding to exercise both components
    const RATE = 1e-3;
    const candles = [
      bar(0,     100),
      bar(H,     105, RATE), // price moved up, funding present
      bar(2 * H, 105),
    ];

    // Use commission to make pricePnl non-trivial
    const result = runBacktest(shortUntil(1), candles, { ...BT_OPTS, commissionPct: 0.0005 });
    const trade = result.trades.find(t => t.side === "short");
    expect(trade).toBeDefined();
    expect(trade!.pnl).toBe(trade!.pricePnl + trade!.fundingPnl);
  });

  it("result totals are consistent: totalPnl === totalPricePnl + totalFundingPnl", () => {
    const RATE = 1e-3;
    const PRICE = 100;
    const candles = [
      bar(0,     PRICE),
      bar(H,     PRICE, RATE),
      bar(2 * H, PRICE, RATE),
      bar(3 * H, PRICE),
    ];

    const result = runBacktest(shortUntil(2), candles, BT_OPTS);
    expect(result.totalPnl).toBe(result.totalPricePnl + result.totalFundingPnl);
    expect(result.totalFundingPnl).toBeGreaterThan(0);
  });
});
