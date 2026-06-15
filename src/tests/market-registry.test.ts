/**
 * Tests for the metric registry generated from market-metrics.manifest.json.
 * No network calls — compute() is exercised against hand-built MarketPollContexts.
 */

import { describe, it, expect } from "vitest";
import { buildRegistry, getImplementedMetrics, metricAppliesTo, safeNum, type MarketPollContext } from "../market/registry.js";
import { loadManifest } from "../market/manifest.js";

const HL_MARKET_LEVEL_KEYS = [
  "perp_mark_px",
  "perp_oracle_px",
  "funding_rate",
  "open_interest",
  "perp_premium",
  "perp_day_ntl_vlm",
  "spot_mark_px",
  "spot_day_ntl_vlm",
  "circulating_supply",
];

const CVD_KEYS = [
  "cvd_perp_1h",
  "cvd_perp_4h",
  "cvd_perp_24h",
  "cvd_spot_1h",
  "cvd_spot_4h",
  "cvd_spot_24h",
  "cvd_perp_trades_24h",
  "cvd_spot_trades_24h",
];

const BOOK_KEYS = [
  "book_mid",
  "book_spread_bps",
  "book_bid_depth",
  "book_ask_depth",
  "book_imbalance",
  "book_spot_spread_bps",
  "book_spot_imbalance",
];

const HL_NATIVE_KEYS = [
  "total_staked_hype",
  "active_staked_hype",
  "validator_count",
  "af_hype_balance",
  "af_buy_hype_window",
  "af_buy_usdc_window",
  "af_buy_fills",
];

const STAGE_1_3_IMPLEMENTED_KEYS = [...HL_MARKET_LEVEL_KEYS, ...CVD_KEYS, ...BOOK_KEYS, ...HL_NATIVE_KEYS];

const ctx: MarketPollContext = {
  symbol: "HYPE",
  perpCtx: {
    markPx: "25.5",
    oraclePx: "25.4",
    funding: "0.00012",
    openInterest: "1000000",
    premium: "0.0008",
    dayNtlVlm: "5000000",
  },
  spotCtx: {
    markPx: "25.6",
    dayNtlVlm: "2000000",
  },
  circulatingSupply: "330000000",
  cvd: {
    perp: { cvd1h: 100, cvd4h: 400, cvd24h: 2400, trades24h: 240 },
    spot: { cvd1h: 50, cvd4h: 200, cvd24h: 1200, trades24h: 120 },
  },
  book: {
    perp: { mid: 25.55, spreadBps: 4, bidDepth: 1000, askDepth: 1000, imbalance: 0 },
    spot: { spreadBps: 6, imbalance: -0.35 },
  },
  hlNative: {
    staking: { totalStaked: 435_000_000, activeStaked: 434_000_000, validatorCount: 32 },
    af: { hypeBalance: 45_000_000, buyHypeWindow: 100, buyUsdcWindow: 2500, buyFills: 5 },
  },
};

describe("safeNum", () => {
  it("parses numeric strings and rejects junk", () => {
    expect(safeNum("25.5")).toBe(25.5);
    expect(safeNum(null)).toBeNull();
    expect(safeNum(undefined)).toBeNull();
    expect(safeNum("not-a-number")).toBeNull();
  });
});

describe("buildRegistry", () => {
  it("produces one MetricDefinition per manifest entry", () => {
    const manifest = loadManifest();
    const registry = buildRegistry();
    expect(registry).toHaveLength(manifest.metrics.length);
    expect(registry.length).toBe(manifest.counts.total);
  });

  it("implements compute() for exactly the 31 stage 1-3 metrics (9 level + 8 CVD/count + 7 book + 7 hl-native)", () => {
    const implemented = getImplementedMetrics().map((m) => m.key).sort();
    expect(implemented).toEqual([...STAGE_1_3_IMPLEMENTED_KEYS].sort());
  });

  it("leaves every other entry as a stub (compute === undefined)", () => {
    const registry = buildRegistry();
    for (const m of registry) {
      if (STAGE_1_3_IMPLEMENTED_KEYS.includes(m.key)) continue;
      expect(m.compute).toBeUndefined();
    }
  });
});

describe("compute() for hl-market level metrics", () => {
  for (const key of HL_MARKET_LEVEL_KEYS) {
    it(`computes a finite numeric value for ${key}`, () => {
      const metric = getImplementedMetrics().find((m) => m.key === key);
      expect(metric).toBeDefined();
      const value = metric!.compute!(ctx);
      expect(value).not.toBeNull();
      expect(Number.isFinite(value)).toBe(true);
    });
  }

  it("returns null for spot metrics when the symbol has no spot market", () => {
    const noSpot: MarketPollContext = { ...ctx, spotCtx: null, circulatingSupply: null };
    const spotMark = getImplementedMetrics().find((m) => m.key === "spot_mark_px")!;
    const circ = getImplementedMetrics().find((m) => m.key === "circulating_supply")!;
    expect(spotMark.compute!(noSpot)).toBeNull();
    expect(circ.compute!(noSpot)).toBeNull();
  });
});

describe("compute() for CVD/trade-count metrics", () => {
  for (const key of CVD_KEYS) {
    it(`computes a finite numeric value for ${key}`, () => {
      const metric = getImplementedMetrics().find((m) => m.key === key);
      expect(metric).toBeDefined();
      const value = metric!.compute!(ctx);
      expect(value).not.toBeNull();
      expect(Number.isFinite(value)).toBe(true);
    });
  }

  it("returns null for every CVD/trade-count metric when no aggregator data is available", () => {
    const noCvd: MarketPollContext = { ...ctx, cvd: null };
    for (const key of CVD_KEYS) {
      const metric = getImplementedMetrics().find((m) => m.key === key)!;
      expect(metric.compute!(noCvd)).toBeNull();
    }
  });
});

describe("compute() for book microstructure metrics", () => {
  for (const key of BOOK_KEYS) {
    it(`computes a finite numeric value for ${key}`, () => {
      const metric = getImplementedMetrics().find((m) => m.key === key);
      expect(metric).toBeDefined();
      const value = metric!.compute!(ctx);
      expect(value).not.toBeNull();
      expect(Number.isFinite(value)).toBe(true);
    });
  }

  it("book_imbalance and book_spot_imbalance stay within [-1, 1]", () => {
    const imbalance = getImplementedMetrics().find((m) => m.key === "book_imbalance")!.compute!(ctx)!;
    const spotImbalance = getImplementedMetrics().find((m) => m.key === "book_spot_imbalance")!.compute!(ctx)!;
    expect(imbalance).toBeGreaterThanOrEqual(-1);
    expect(imbalance).toBeLessThanOrEqual(1);
    expect(spotImbalance).toBeGreaterThanOrEqual(-1);
    expect(spotImbalance).toBeLessThanOrEqual(1);
    expect(spotImbalance).toBe(-0.35);
  });

  it("returns null for every book metric when no book data is available", () => {
    const noBook: MarketPollContext = { ...ctx, book: { perp: null, spot: null } };
    for (const key of BOOK_KEYS) {
      const metric = getImplementedMetrics().find((m) => m.key === key)!;
      expect(metric.compute!(noBook)).toBeNull();
    }
  });
});

describe("compute() for hl-native staking + AF metrics", () => {
  for (const key of HL_NATIVE_KEYS) {
    it(`computes a finite numeric value for ${key}`, () => {
      const metric = getImplementedMetrics().find((m) => m.key === key);
      expect(metric).toBeDefined();
      const value = metric!.compute!(ctx);
      expect(value).not.toBeNull();
      expect(Number.isFinite(value)).toBe(true);
    });
  }

  it("returns null for every hl-native metric when no staking/AF data is available", () => {
    const noHlNative: MarketPollContext = { ...ctx, hlNative: null };
    for (const key of HL_NATIVE_KEYS) {
      const metric = getImplementedMetrics().find((m) => m.key === key)!;
      expect(metric.compute!(noHlNative)).toBeNull();
    }
  });

  it("returns null af_hype_balance but numeric AF window/count metrics when the AF token couldn't be resolved", () => {
    const noAfBalance: MarketPollContext = {
      ...ctx,
      hlNative: { ...ctx.hlNative!, af: { hypeBalance: null, buyHypeWindow: 0, buyUsdcWindow: 0, buyFills: 0 } },
    };
    expect(getImplementedMetrics().find((m) => m.key === "af_hype_balance")!.compute!(noAfBalance)).toBeNull();
    expect(getImplementedMetrics().find((m) => m.key === "af_buy_hype_window")!.compute!(noAfBalance)).toBe(0);
  });
});

describe("metricAppliesTo", () => {
  it("'all' applies to any symbol", () => {
    const m = getImplementedMetrics().find((d) => d.key === "perp_mark_px")!;
    expect(metricAppliesTo(m, "HYPE")).toBe(true);
    expect(metricAppliesTo(m, "ETH")).toBe(true);
  });

  it("'hype-only' applies only to HYPE", () => {
    const m = getImplementedMetrics().find((d) => d.key === "circulating_supply")!;
    expect(m.appliesTo).toBe("hype-only");
    expect(metricAppliesTo(m, "HYPE")).toBe(true);
    expect(metricAppliesTo(m, "ETH")).toBe(false);
  });
});
