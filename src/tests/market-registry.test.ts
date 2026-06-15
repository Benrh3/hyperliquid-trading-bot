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

const CEX_KEYS = [
  "cex_oi_binance_hype",
  "cex_oi_bybit_hype",
  "cex_oi_okx_hype",
  "cex_oi_total_hype",
  "lsr_binance_global",
  "lsr_binance_top_pos",
  "lsr_binance_taker",
  "lsr_bybit_account",
  "lsr_okx_account",
  "lsr_okx_top_pos",
  "lsr_okx_taker",
  "lsr_agg_long_frac",
  "cex_liq_long_1h",
  "cex_liq_short_1h",
  "cex_liq_long_24h",
  "cex_liq_short_24h",
  "cex_liq_net_24h",
  "cex_liq_count_24h",
];

const ON_CHAIN_KEYS = [
  "cex_inflow_hype",
  "cex_outflow_hype",
  "cex_net_flow_hype",
  "cex_net_flow_usdc",
  "cex_total_balance_hype",
  "cex_wallets_polled",
  "holders_count",
  "holder_supply_ex_system",
  "holder_top10_share",
  "holder_top50_share",
  "holder_top100_share",
];

const STAGE_1_5_IMPLEMENTED_KEYS = [...HL_MARKET_LEVEL_KEYS, ...CVD_KEYS, ...BOOK_KEYS, ...HL_NATIVE_KEYS, ...CEX_KEYS, ...ON_CHAIN_KEYS];

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
  cex: {
    oi: { binance: 5_000_000, bybit: 3_000_000, okx: 1_700_000, total: 9_700_000 },
    lsr: {
      binanceGlobal: 1.1, binanceTopPos: 1.4, binanceTaker: 1.05,
      bybitAccount: 1.5,
      okxAccount: 1.03, okxTopPos: 1.17, okxTaker: 2.5,
      aggLongFrac: 0.52,
    },
    liq: {
      long1h: 10, short1h: 5, long24h: 200, short24h: 150, net24h: -50, count24h: 42,
    },
  },
  onChain: {
    totalBalance: 12_345.6,
    walletsPolled: 3,
    netFlow: 100,
    inflow: 150,
    outflow: 50,
    netFlowUsdc: 2550,
    holders: {
      count: 243_766,
      supplyExSystem: 142_800_000,
      top10Share: 0.42,
      top50Share: 0.65,
      top100Share: 0.78,
    },
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

  it("implements compute() for exactly the 60 stage 1-5 metrics (9 level + 8 CVD/count + 7 book + 7 hl-native + 18 cex-agg + 11 on-chain)", () => {
    const implemented = getImplementedMetrics().map((m) => m.key).sort();
    expect(implemented).toEqual([...STAGE_1_5_IMPLEMENTED_KEYS].sort());
  });

  it("leaves every other entry as a stub (compute === undefined)", () => {
    const registry = buildRegistry();
    for (const m of registry) {
      if (STAGE_1_5_IMPLEMENTED_KEYS.includes(m.key)) continue;
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

describe("compute() for cex-agg metrics", () => {
  for (const key of CEX_KEYS) {
    it(`computes a finite numeric value for ${key}`, () => {
      const metric = getImplementedMetrics().find((m) => m.key === key);
      expect(metric).toBeDefined();
      const value = metric!.compute!(ctx);
      expect(value).not.toBeNull();
      expect(Number.isFinite(value)).toBe(true);
    });
  }

  it("returns null for every cex-agg metric when no CEX data is available", () => {
    const noCex: MarketPollContext = { ...ctx, cex: null };
    for (const key of CEX_KEYS) {
      const metric = getImplementedMetrics().find((m) => m.key === key)!;
      expect(metric.compute!(noCex)).toBeNull();
    }
  });

  it("nulls only the unavailable venue's OI/LSR fields, leaving other venues intact", () => {
    const binanceDown: MarketPollContext = {
      ...ctx,
      cex: {
        ...ctx.cex!,
        oi: { ...ctx.cex!.oi, binance: null },
        lsr: { ...ctx.cex!.lsr, binanceGlobal: null, binanceTopPos: null, binanceTaker: null },
      },
    };
    expect(getImplementedMetrics().find((m) => m.key === "cex_oi_binance_hype")!.compute!(binanceDown)).toBeNull();
    expect(getImplementedMetrics().find((m) => m.key === "lsr_binance_global")!.compute!(binanceDown)).toBeNull();
    expect(getImplementedMetrics().find((m) => m.key === "cex_oi_bybit_hype")!.compute!(binanceDown)).toBe(3_000_000);
    expect(getImplementedMetrics().find((m) => m.key === "lsr_okx_account")!.compute!(binanceDown)).toBe(1.03);
  });

  it("returns null cex_liq_* when no liquidation stream is running", () => {
    const noLiq: MarketPollContext = { ...ctx, cex: { ...ctx.cex!, liq: null } };
    for (const key of ["cex_liq_long_1h", "cex_liq_short_1h", "cex_liq_long_24h", "cex_liq_short_24h", "cex_liq_net_24h", "cex_liq_count_24h"]) {
      expect(getImplementedMetrics().find((m) => m.key === key)!.compute!(noLiq)).toBeNull();
    }
  });
});

describe("compute() for on-chain CEX-flow + holder metrics", () => {
  for (const key of ON_CHAIN_KEYS) {
    it(`computes a finite numeric value for ${key}`, () => {
      const metric = getImplementedMetrics().find((m) => m.key === key);
      expect(metric).toBeDefined();
      const value = metric!.compute!(ctx);
      expect(value).not.toBeNull();
      expect(Number.isFinite(value)).toBe(true);
    });
  }

  it("returns null for every on-chain metric except cex_wallets_polled when onChain is null", () => {
    const noOnChain: MarketPollContext = { ...ctx, onChain: null };
    for (const key of ON_CHAIN_KEYS) {
      const metric = getImplementedMetrics().find((m) => m.key === key)!;
      expect(metric.compute!(noOnChain)).toBeNull();
    }
  });

  it("returns null holder metrics when holders is null but balance/flow metrics remain", () => {
    const noHolders: MarketPollContext = { ...ctx, onChain: { ...ctx.onChain!, holders: null } };
    for (const key of ["holders_count", "holder_supply_ex_system", "holder_top10_share", "holder_top50_share", "holder_top100_share"]) {
      expect(getImplementedMetrics().find((m) => m.key === key)!.compute!(noHolders)).toBeNull();
    }
    expect(getImplementedMetrics().find((m) => m.key === "cex_total_balance_hype")!.compute!(noHolders)).toBe(12_345.6);
  });

  it("the empty-wallets default state: balance/flow metrics null, wallets_polled = 0", () => {
    const empty: MarketPollContext = {
      ...ctx,
      onChain: {
        totalBalance: null, walletsPolled: 0,
        netFlow: null, inflow: null, outflow: null, netFlowUsdc: null,
        holders: null,
      },
    };
    for (const key of ["cex_total_balance_hype", "cex_net_flow_hype", "cex_inflow_hype", "cex_outflow_hype", "cex_net_flow_usdc"]) {
      expect(getImplementedMetrics().find((m) => m.key === key)!.compute!(empty)).toBeNull();
    }
    expect(getImplementedMetrics().find((m) => m.key === "cex_wallets_polled")!.compute!(empty)).toBe(0);
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
