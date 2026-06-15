/**
 * SnapshotPoller integration tests for cex-agg (stage 4) — no live network
 * calls. Verifies the 18 cex-agg metrics are written tagged source="cex-agg",
 * cex_oi_total_hype/lsr_agg_long_frac are computed from available venues,
 * cex_liq_* meta_json carries filled fractions, and an unreachable venue
 * nulls only its own metrics.
 */

import { describe, it, expect, vi } from "vitest";
import { MarketStore } from "../market/store.js";
import { SnapshotPoller, type MarketInfoClient, type CexVenueSources } from "../market/poller.js";
import type { CexDerivsSource, CexLiqEvent, LongShortRatios } from "../market/cex/types.js";

const CANONICAL_HYPE_TOKEN_ID = "0x0d01dc56dcaaca66ad901c959b4011ec";
const CANONICAL_HYPE_TOKEN_INDEX = 150;
const NULL_LSR: LongShortRatios = { accountRatio: null, topPositionRatio: null, takerRatio: null };

const CEX_KEYS = [
  "cex_oi_binance_hype", "cex_oi_bybit_hype", "cex_oi_okx_hype", "cex_oi_total_hype",
  "lsr_binance_global", "lsr_binance_top_pos", "lsr_binance_taker",
  "lsr_bybit_account",
  "lsr_okx_account", "lsr_okx_top_pos", "lsr_okx_taker",
  "lsr_agg_long_frac",
  "cex_liq_long_1h", "cex_liq_short_1h", "cex_liq_long_24h", "cex_liq_short_24h", "cex_liq_net_24h", "cex_liq_count_24h",
];

function makeMockInfo(): MarketInfoClient {
  return {
    metaAndAssetCtxs: vi.fn().mockResolvedValue([
      { universe: [{ name: "HYPE" }] },
      [{ markPx: "25.5", oraclePx: "25.4", funding: "0.00012", openInterest: "1000000", premium: "0.0008", dayNtlVlm: "5000000" }],
    ]),
    spotMetaAndAssetCtxs: vi.fn().mockResolvedValue([
      {
        tokens: [
          { name: "USDC", index: 0, tokenId: "0x00000000000000000000000000000000" },
          { name: "HYPE", index: CANONICAL_HYPE_TOKEN_INDEX, tokenId: CANONICAL_HYPE_TOKEN_ID },
        ],
        universe: [{ tokens: [CANONICAL_HYPE_TOKEN_INDEX, 0], index: 107 }],
      },
      [{ markPx: "25.6", dayNtlVlm: "2000000", coin: "@107" }],
    ]),
    tokenDetails: vi.fn().mockResolvedValue({ circulatingSupply: "330000000" }),
    l2Book: vi.fn().mockResolvedValue(null),
    validatorSummaries: vi.fn().mockResolvedValue([]),
    spotClearinghouseState: vi.fn().mockResolvedValue({ balances: [] }),
    userFillsByTime: vi.fn().mockResolvedValue([]),
  };
}

function makeMockCexSource(opts: { available: boolean; oi?: number | null; lsr?: LongShortRatios }): CexDerivsSource {
  return {
    name: "mock",
    resolveSymbol: vi.fn().mockResolvedValue(opts.available),
    isAvailable: () => opts.available,
    fetchOpenInterest: vi.fn().mockResolvedValue(opts.oi ?? null),
    fetchLongShortRatios: vi.fn().mockResolvedValue(opts.lsr ?? NULL_LSR),
    startLiquidationStream: vi.fn<(onLiq: (event: CexLiqEvent) => void) => void>(),
    stopLiquidationStream: vi.fn(),
  };
}

describe("SnapshotPoller — cex-agg (stage 4)", () => {
  it("writes all 18 cex-agg metrics tagged source=cex-agg, with cex_oi_total_hype and lsr_agg_long_frac computed from available venues", async () => {
    const store = new MarketStore(":memory:");
    const info = makeMockInfo();

    const cexSources = new Map<string, CexVenueSources>([
      ["HYPE", {
        binance: makeMockCexSource({ available: true, oi: 5_000_000, lsr: { accountRatio: 1.1, topPositionRatio: 1.4, takerRatio: 1.05 } }),
        bybit:   makeMockCexSource({ available: true, oi: 3_000_000, lsr: { accountRatio: 1.5, topPositionRatio: null, takerRatio: null } }),
        okx:     makeMockCexSource({ available: true, oi: 1_700_000, lsr: { accountRatio: 1.03, topPositionRatio: 1.17, takerRatio: 2.5 } }),
      }],
    ]);

    const poller = new SnapshotPoller(store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, cexSources, undefined, undefined, () => Promise.resolve(null));
    await poller.poll();

    const rows = store.getRecentSnapshots("HYPE", 10);
    const metrics = rows[0].metrics;

    for (const key of CEX_KEYS) {
      expect(metrics[key]).toBeDefined();
      expect(metrics[key].source).toBe("cex-agg");
      expect(metrics[key].capturedAt).toBeGreaterThan(0);
    }

    expect(metrics.cex_oi_binance_hype.value).toBe(5_000_000);
    expect(metrics.cex_oi_bybit_hype.value).toBe(3_000_000);
    expect(metrics.cex_oi_okx_hype.value).toBe(1_700_000);
    expect(metrics.cex_oi_total_hype.value).toBe(9_700_000);
    expect(metrics.lsr_agg_long_frac.value).not.toBeNull();

    store.close();
  });

  it("records filled fractions in meta_json for cex_liq_* metrics when at least one venue stream is running", async () => {
    const store = new MarketStore(":memory:");
    const info = makeMockInfo();

    const cexSources = new Map<string, CexVenueSources>([
      ["HYPE", {
        binance: makeMockCexSource({ available: true, oi: 5_000_000, lsr: NULL_LSR }),
        bybit:   makeMockCexSource({ available: false }),
        okx:     makeMockCexSource({ available: false }),
      }],
    ]);

    const poller = new SnapshotPoller(store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, cexSources, undefined, undefined, () => Promise.resolve(null));
    await poller.poll();

    const metrics = store.getRecentSnapshots("HYPE", 10)[0].metrics;
    for (const key of ["cex_liq_long_1h", "cex_liq_short_1h", "cex_liq_long_24h", "cex_liq_short_24h", "cex_liq_net_24h", "cex_liq_count_24h"]) {
      expect(metrics[key].value).toBe(0);
      const meta = metrics[key].meta as { filled: number };
      expect(meta.filled).toBeGreaterThan(0);
    }

    store.close();
  });

  it("nulls only the unreachable venue's OI/LSR metrics, leaving other venues' metrics intact", async () => {
    const store = new MarketStore(":memory:");
    const info = makeMockInfo();

    const cexSources = new Map<string, CexVenueSources>([
      ["HYPE", {
        binance: makeMockCexSource({ available: false }), // geo-blocked / not listed
        bybit:   makeMockCexSource({ available: true, oi: 3_000_000, lsr: { accountRatio: 1.5, topPositionRatio: null, takerRatio: null } }),
        okx:     makeMockCexSource({ available: true, oi: 1_700_000, lsr: { accountRatio: 1.03, topPositionRatio: 1.17, takerRatio: 2.5 } }),
      }],
    ]);

    const poller = new SnapshotPoller(store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, cexSources, undefined, undefined, () => Promise.resolve(null));
    await poller.poll();

    const metrics = store.getRecentSnapshots("HYPE", 10)[0].metrics;

    expect(metrics.cex_oi_binance_hype.value).toBeNull();
    expect(metrics.lsr_binance_global.value).toBeNull();
    expect(metrics.lsr_binance_top_pos.value).toBeNull();
    expect(metrics.lsr_binance_taker.value).toBeNull();

    // Bybit + OKX still contribute.
    expect(metrics.cex_oi_bybit_hype.value).toBe(3_000_000);
    expect(metrics.cex_oi_okx_hype.value).toBe(1_700_000);
    expect(metrics.cex_oi_total_hype.value).toBe(4_700_000); // binance excluded
    expect(metrics.lsr_okx_account.value).toBe(1.03);

    store.close();
  });

  it("never calls fetchOpenInterest/fetchLongShortRatios for an unavailable venue", async () => {
    const store = new MarketStore(":memory:");
    const info = makeMockInfo();

    const binance = makeMockCexSource({ available: false });
    const cexSources = new Map<string, CexVenueSources>([
      ["HYPE", {
        binance,
        bybit: makeMockCexSource({ available: true, oi: 3_000_000, lsr: NULL_LSR }),
        okx:   makeMockCexSource({ available: true, oi: 1_700_000, lsr: NULL_LSR }),
      }],
    ]);

    const poller = new SnapshotPoller(store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, cexSources, undefined, undefined, () => Promise.resolve(null));
    await poller.poll();

    expect(binance.fetchOpenInterest).not.toHaveBeenCalled();
    expect(binance.fetchLongShortRatios).not.toHaveBeenCalled();

    store.close();
  });
});
