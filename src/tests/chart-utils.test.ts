import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  aggregatePnl,
  selectRange,
  downsample,
  alignFundingRows,
  type BotPnlEntry,
  type FundingRow,
} from "../chart-utils.js";

// ── aggregatePnl ──────────────────────────────────────────────────────────────

describe("aggregatePnl", () => {
  it("sums realized, unrealized, total, and tradeCount correctly", () => {
    const bots: BotPnlEntry[] = [
      { realizedPnl: 10,  unrealizedPnl: -2,  totalPnl: 8,   tradeCount: 3 },
      { realizedPnl: -5,  unrealizedPnl: 1,   totalPnl: -4,  tradeCount: 2 },
      { realizedPnl: 0.5, unrealizedPnl: 0.1, totalPnl: 0.6, tradeCount: 1 },
    ];
    const r = aggregatePnl(bots);
    expect(r.realizedPnl).toBeCloseTo(5.5);
    expect(r.unrealizedPnl).toBeCloseTo(-0.9);
    expect(r.totalPnl).toBeCloseTo(4.6);
    expect(r.tradeCount).toBe(6);
  });

  it("returns zeros for an empty array", () => {
    const r = aggregatePnl([]);
    expect(r.realizedPnl).toBe(0);
    expect(r.unrealizedPnl).toBe(0);
    expect(r.totalPnl).toBe(0);
    expect(r.tradeCount).toBe(0);
  });

  it("treats NaN and non-finite values as zero", () => {
    const bots: BotPnlEntry[] = [
      { realizedPnl: NaN,      unrealizedPnl: Infinity, totalPnl: NaN,  tradeCount: 1   },
      { realizedPnl: 5,        unrealizedPnl: -1,       totalPnl: 4,    tradeCount: NaN as unknown as number },
      { realizedPnl: -Infinity, unrealizedPnl: 2,       totalPnl: -3,   tradeCount: 2   },
    ];
    const r = aggregatePnl(bots);
    expect(r.realizedPnl).toBeCloseTo(5);      // NaN + 5 + -Inf → 0 + 5 + 0
    expect(r.unrealizedPnl).toBeCloseTo(1);    // Inf + -1 + 2  → 0 + -1 + 2
    expect(r.totalPnl).toBeCloseTo(1);         // NaN + 4 + -3  → 0 + 4 + -3
    expect(r.tradeCount).toBe(3);              // 1 + NaN + 2   → 1 + 0 + 2
  });

  it("handles a single bot correctly", () => {
    const r = aggregatePnl([{ realizedPnl: 42, unrealizedPnl: -7, totalPnl: 35, tradeCount: 10 }]);
    expect(r.realizedPnl).toBeCloseTo(42);
    expect(r.unrealizedPnl).toBeCloseTo(-7);
    expect(r.totalPnl).toBeCloseTo(35);
    expect(r.tradeCount).toBe(10);
  });
});

// ── selectRange ───────────────────────────────────────────────────────────────

describe("selectRange", () => {
  const now = 1_700_000_000_000; // fixed "now"

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(()  => { vi.useRealTimers(); });

  const rows = [
    { ts: now - 30 * 60_000 },   // 30 min ago  ✓ in 1h
    { ts: now - 2 * 3_600_000 }, // 2 h ago     ✗ outside 1h, ✓ in 24h
    { ts: now - 8 * 3_600_000 }, // 8 h ago     ✗ outside 1h/24h, ✓ in 7d
    { ts: now - 4 * 86_400_000}, // 4 days ago  ✓ in 7d
    { ts: now - 10 * 86_400_000},// 10 days ago ✗ outside all
  ];

  it("returns rows within 1 hour", () => {
    const result = selectRange(rows, 60 * 60_000);
    expect(result).toHaveLength(1);
    expect(result[0].ts).toBe(now - 30 * 60_000);
  });

  it("returns rows within 24 hours (30min + 2h + 8h = 3 rows)", () => {
    const result = selectRange(rows, 24 * 3_600_000);
    expect(result).toHaveLength(3);
  });

  it("returns rows within 7 days", () => {
    const result = selectRange(rows, 7 * 86_400_000);
    expect(result).toHaveLength(4);
  });

  it("returns empty for non-finite rangeMs", () => {
    expect(selectRange(rows, NaN)).toHaveLength(0);
    expect(selectRange(rows, -1)).toHaveLength(0);
    expect(selectRange(rows, Infinity)).toHaveLength(0);
  });

  it("does not mutate input", () => {
    const input = [{ ts: now - 100 }];
    const result = selectRange(input, 60_000);
    expect(result).not.toBe(input);
  });
});

// ── downsample ────────────────────────────────────────────────────────────────

describe("downsample", () => {
  const makeRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ts: i * 1000 }));

  it("returns rows unchanged when already within maxPoints", () => {
    const rows = makeRows(10);
    expect(downsample(rows, 10)).toHaveLength(10);
    expect(downsample(rows, 20)).toHaveLength(10);
  });

  it("reduces to exactly maxPoints", () => {
    expect(downsample(makeRows(1000), 100)).toHaveLength(100);
    expect(downsample(makeRows(500),  50)).toHaveLength(50);
  });

  it("always preserves the first and last points", () => {
    const rows = makeRows(1000);
    const result = downsample(rows, 100);
    expect(result[0].ts).toBe(rows[0].ts);
    expect(result[result.length - 1].ts).toBe(rows[rows.length - 1].ts);
  });

  it("returns empty array for empty input", () => {
    expect(downsample([], 100)).toHaveLength(0);
  });

  it("returns empty for maxPoints < 1", () => {
    expect(downsample(makeRows(10), 0)).toHaveLength(0);
  });

  it("does not mutate input", () => {
    const rows = makeRows(100);
    const copy = rows.map((r) => ({ ...r }));
    downsample(rows, 10);
    expect(rows).toEqual(copy);
  });

  it("result rows are monotonically increasing by ts", () => {
    const rows = makeRows(500);
    const result = downsample(rows, 50);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].ts).toBeGreaterThanOrEqual(result[i - 1].ts);
    }
  });
});

// ── alignFundingRows ──────────────────────────────────────────────────────────

describe("alignFundingRows", () => {
  const t = (offsetS: number) => offsetS * 1000; // helper: ts in ms

  const makeRow = (ts: number, venue: string, rate: number): FundingRow =>
    ({ ts, venue, rate_hourly: rate });

  it("aligns HL and dYdX rows by timestamp and computes spread", () => {
    const rows: FundingRow[] = [
      makeRow(t(0),   "hyperliquid", 0.001),
      makeRow(t(0),   "dydx",        0.0004),
      makeRow(t(45),  "hyperliquid", 0.0008),
      makeRow(t(45),  "dydx",        0.0006),
    ];
    const result = alignFundingRows(rows);
    expect(result).toHaveLength(2);
    const first = result.find((r) => r.hl !== null && Math.abs(r.hl - 0.001) < 1e-9)!;
    expect(first.hl).toBeCloseTo(0.001);
    expect(first.dydx).toBeCloseTo(0.0004);
    expect(first.spread).toBeCloseTo(0.0006);
  });

  it("marks spread null when only one venue has data for that timestamp", () => {
    const rows: FundingRow[] = [
      makeRow(t(0),  "hyperliquid", 0.001),
      makeRow(t(10), "dydx",        0.0004),
    ];
    const result = alignFundingRows(rows);
    // Different buckets → each has one venue missing
    expect(result.every((r) => r.spread === null)).toBe(true);
  });

  it("returns sorted by ts ascending", () => {
    const rows: FundingRow[] = [
      makeRow(t(90),  "hyperliquid", 0.002),
      makeRow(t(90),  "dydx",        0.001),
      makeRow(t(0),   "hyperliquid", 0.001),
      makeRow(t(0),   "dydx",        0.0005),
    ];
    const result = alignFundingRows(rows);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].ts).toBeGreaterThanOrEqual(result[i - 1].ts);
    }
  });

  it("skips rows with non-finite rate", () => {
    const rows: FundingRow[] = [
      makeRow(t(0), "hyperliquid", NaN),
      makeRow(t(0), "dydx",        0.001),
    ];
    const result = alignFundingRows(rows);
    // HL was skipped → only dYdX bucket → spread null
    expect(result.some((r) => r.hl !== null)).toBe(false);
    expect(result.some((r) => r.dydx !== null)).toBe(true);
  });

  it("returns empty for empty input", () => {
    expect(alignFundingRows([])).toHaveLength(0);
  });

  it("spread is always non-negative", () => {
    const rows: FundingRow[] = [
      makeRow(t(0), "hyperliquid", -0.001),
      makeRow(t(0), "dydx",         0.0005),
    ];
    const result = alignFundingRows(rows);
    for (const r of result) {
      if (r.spread !== null) expect(r.spread).toBeGreaterThanOrEqual(0);
    }
  });
});
