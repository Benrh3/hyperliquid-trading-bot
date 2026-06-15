/**
 * Tests for cex-agg's pure aggregation helpers — OI normalization,
 * cross-venue OI total, and the OI-weighted aggregate long fraction.
 * No network calls.
 */

import { describe, it, expect } from "vitest";
import { normalizeOi } from "../market/cex/types.js";
import { computeOiTotal, computeAggLongFrac, aggregateLiqWindows } from "../market/cex/aggregate.js";
import type { CexLiqWindows } from "../market/cex/liqTracker.js";

describe("normalizeOi", () => {
  it("passes coin-denominated OI through unchanged", () => {
    expect(normalizeOi(1_696_356, "coins", null)).toBe(1_696_356);
    expect(normalizeOi(1_696_356, "coins", 68.5)).toBe(1_696_356);
  });

  it("divides a USD-notional reading by the mark price to get coin units", () => {
    // 169,635.6 USD / 68.06 USD-per-HYPE = 2,492.44... HYPE.
    expect(normalizeOi(169_635.6, "usd", 68.06)).toBeCloseTo(2492.44, 2);
  });

  it("returns null for a USD reading with no mark price available", () => {
    expect(normalizeOi(115_437_025.8, "usd", null)).toBeNull();
    expect(normalizeOi(115_437_025.8, "usd", 0)).toBeNull();
    expect(normalizeOi(115_437_025.8, "usd", -1)).toBeNull();
  });

  it("returns null for a non-finite raw reading", () => {
    expect(normalizeOi(NaN, "coins", null)).toBeNull();
  });
});

describe("computeOiTotal", () => {
  it("sums the available per-venue readings", () => {
    expect(computeOiTotal([5_000_000, 3_000_000, 1_700_000])).toBe(9_700_000);
  });

  it("sums whichever venues are available, ignoring nulls", () => {
    expect(computeOiTotal([5_000_000, null, 1_700_000])).toBe(6_700_000);
  });

  it("returns null when no venue is available", () => {
    expect(computeOiTotal([null, null, null])).toBeNull();
  });
});

describe("computeAggLongFrac", () => {
  it("computes the OI-weighted average of r/(1+r) across venues", () => {
    // venue A: ratio 1 -> longFrac 0.5, weight 100
    // venue B: ratio 3 -> longFrac 0.75, weight 300
    // weighted avg = (0.5*100 + 0.75*300) / 400 = 0.6875
    const result = computeAggLongFrac([
      { accountRatio: 1, oi: 100 },
      { accountRatio: 3, oi: 300 },
    ]);
    expect(result).toBeCloseTo(0.6875, 10);
  });

  it("excludes venues without an account ratio (unsupported stat)", () => {
    const result = computeAggLongFrac([
      { accountRatio: 1, oi: 100 },
      { accountRatio: null, oi: 300 }, // unsupported — excluded entirely
    ]);
    // Only venue A contributes: longFrac 0.5, weight 100 -> 0.5
    expect(result).toBeCloseTo(0.5, 10);
  });

  it("excludes venues without an OI weight", () => {
    const result = computeAggLongFrac([
      { accountRatio: 1, oi: null },
      { accountRatio: 3, oi: 300 },
    ]);
    expect(result).toBeCloseTo(0.75, 10);
  });

  it("returns null when no venue has both an account ratio and OI", () => {
    expect(computeAggLongFrac([{ accountRatio: null, oi: 100 }, { accountRatio: 1, oi: null }])).toBeNull();
    expect(computeAggLongFrac([])).toBeNull();
  });
});

describe("aggregateLiqWindows", () => {
  function windows(overrides: Partial<CexLiqWindows> = {}): CexLiqWindows {
    return {
      longVol1h: 0, shortVol1h: 0, count1h: 0, filled1h: 1,
      longVol24h: 0, shortVol24h: 0, count24h: 0, filled24h: 1,
      ...overrides,
    };
  }

  it("sums per-venue windows across venues", () => {
    const result = aggregateLiqWindows([
      windows({ longVol1h: 10, shortVol1h: 5, longVol24h: 100, shortVol24h: 50, count24h: 4 }),
      windows({ longVol1h: 2, shortVol1h: 1, longVol24h: 20, shortVol24h: 10, count24h: 1 }),
    ]);
    expect(result).not.toBeNull();
    expect(result!.longVol1h).toBe(12);
    expect(result!.shortVol1h).toBe(6);
    expect(result!.longVol24h).toBe(120);
    expect(result!.shortVol24h).toBe(60);
    expect(result!.count24h).toBe(5);
  });

  it("takes the minimum filled fraction across venues (conservative coverage)", () => {
    const result = aggregateLiqWindows([
      windows({ filled1h: 1, filled24h: 1 }),
      windows({ filled1h: 0.5, filled24h: 0.1 }),
    ]);
    expect(result!.filled1h).toBe(0.5);
    expect(result!.filled24h).toBe(0.1);
  });

  it("returns null when no venue streams are running", () => {
    expect(aggregateLiqWindows([])).toBeNull();
  });
});
