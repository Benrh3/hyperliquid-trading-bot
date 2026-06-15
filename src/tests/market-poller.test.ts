/**
 * Dry-run tests for SnapshotPoller using a mocked HL info client — no live
 * network calls. Verifies the poll→persist flow writes the 9 hl-market level
 * metrics tagged with source/kind/captured_at, and that an upstream error
 * leaves the store untouched rather than throwing.
 */

import { describe, it, expect, vi } from "vitest";
import { MarketStore } from "../market/store.js";
import { SnapshotPoller, type MarketInfoClient, type TradesAggregatorLike } from "../market/poller.js";
import { getImplementedMetrics } from "../market/registry.js";
import type { CoinWindows } from "../market/tradesAggregator.js";
import type { L2BookLike } from "../market/book.js";

const CANONICAL_HYPE_TOKEN_ID = "0x0d01dc56dcaaca66ad901c959b4011ec";
const IMPOSTER_HYPE_TOKEN_ID  = "0xbad0000000000000000000000000bad";
const CANONICAL_HYPE_TOKEN_INDEX = 150;
const AF_ADDRESS = "0xfefefefefefefefefefefefefefefefefefefefe";

function makeMockBook(bidPx: string, bidSz: string, askPx: string, askSz: string): L2BookLike {
  return { levels: [[{ px: bidPx, sz: bidSz }], [{ px: askPx, sz: askSz }]] };
}

function makeMockInfo(): MarketInfoClient {
  return {
    metaAndAssetCtxs: vi.fn().mockResolvedValue([
      { universe: [{ name: "BTC" }, { name: "HYPE" }] },
      [
        { markPx: "60000", oraclePx: "60010", funding: "0.00001", openInterest: "500", premium: "0.0001", dayNtlVlm: "1000000" },
        { markPx: "25.5", oraclePx: "25.4", funding: "0.00012", openInterest: "1000000", premium: "0.0008", dayNtlVlm: "5000000" },
      ],
    ]),
    spotMetaAndAssetCtxs: vi.fn().mockResolvedValue([
      {
        tokens: [
          { name: "USDC", index: 0, tokenId: "0x00000000000000000000000000000000" },
          { name: "HYPE", index: 5, tokenId: IMPOSTER_HYPE_TOKEN_ID },
          { name: "HYPE", index: 150, tokenId: CANONICAL_HYPE_TOKEN_ID },
        ],
        universe: [
          { tokens: [5, 0], index: 105 },
          { tokens: [150, 0], index: 107 },
        ],
      },
      [
        { markPx: "0.091069", dayNtlVlm: "1000", coin: "@105" },
        { markPx: "25.6", dayNtlVlm: "2000000", coin: "@107" },
      ],
    ]),
    tokenDetails: vi.fn().mockResolvedValue({ circulatingSupply: "330000000" }),
    l2Book: vi.fn().mockImplementation(async ({ coin }: { coin: string }) => {
      if (coin === "HYPE") return makeMockBook("25.49", "100", "25.51", "100");
      if (coin === "@107") return makeMockBook("25.59", "32.5", "25.61", "67.5");
      return null;
    }),
    validatorSummaries: vi.fn().mockResolvedValue([
      { stake: 600_000_000e8, isJailed: false, isActive: true },
      { stake: 400_000_000e8, isJailed: false, isActive: true },
      { stake: 10_000_000e8,  isJailed: true,  isActive: false },
    ]),
    spotClearinghouseState: vi.fn().mockResolvedValue({
      balances: [
        { coin: "USDC", token: 0, total: "9108.0" },
        { coin: "HYPE", token: CANONICAL_HYPE_TOKEN_INDEX, total: "45219365.9" },
      ],
    }),
    userFillsByTime: vi.fn().mockResolvedValue([]),
  };
}

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
  "cvd_perp_1h", "cvd_perp_4h", "cvd_perp_24h",
  "cvd_spot_1h", "cvd_spot_4h", "cvd_spot_24h",
  "cvd_perp_trades_24h", "cvd_spot_trades_24h",
];

const BOOK_KEYS = [
  "book_mid", "book_spread_bps", "book_bid_depth", "book_ask_depth", "book_imbalance",
  "book_spot_spread_bps", "book_spot_imbalance",
];

const HL_NATIVE_KEYS = [
  "total_staked_hype", "active_staked_hype", "validator_count",
  "af_hype_balance", "af_buy_hype_window", "af_buy_usdc_window", "af_buy_fills",
];

const STAGE_3B_KEYS = [
  "unstake_queue_hype", "unstake_maturing_24h", "unstake_maturing_72h",
  "twap_spot_buy_hype", "twap_spot_sell_hype", "twap_perp_buy_hype", "twap_perp_sell_hype",
  "twap_spot_buy_full_hype", "twap_spot_sell_full_hype", "twap_perp_buy_full_hype", "twap_perp_sell_full_hype",
  "twap_active_count",
  "hl_liq_long_1h", "hl_liq_short_1h", "hl_liq_long_24h", "hl_liq_short_24h", "hl_liq_net_24h", "hl_liq_count_24h",
];

function makeMockAggregator(perp: CoinWindows, spot: CoinWindows | null): TradesAggregatorLike {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop:  vi.fn().mockResolvedValue(undefined),
    getPerpWindows: () => perp,
    getSpotWindows: () => spot,
  };
}

function fullWindows(overrides: Partial<CoinWindows> = {}): CoinWindows {
  return {
    cvd1h: 0, cvd4h: 0, cvd24h: 0, trades24h: 0,
    filled1h: 1, filled4h: 1, filled24h: 1,
    ...overrides,
  };
}

describe("SnapshotPoller (dry-run, mocked HL client)", () => {
  it("writes a snapshot with the 9 hl-market level metrics tagged source/kind/captured_at", async () => {
    const store = new MarketStore(":memory:");
    const info  = makeMockInfo();
    const poller = new SnapshotPoller(store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, undefined, undefined, undefined, () => Promise.resolve(null));

    await poller.poll();

    const rows = store.getRecentSnapshots("HYPE", 10);
    expect(rows).toHaveLength(1);

    const metrics = rows[0].metrics;
    for (const key of HL_MARKET_LEVEL_KEYS) {
      expect(metrics[key]).toBeDefined();
      expect(metrics[key].source).toBe("hl-market");
      expect(metrics[key].kind).toBe("level");
      expect(metrics[key].capturedAt).toBeGreaterThan(0);
      expect(metrics[key].value).not.toBeNull();
    }

    expect(metrics.perp_mark_px.value).toBe(25.5);
    expect(metrics.circulating_supply.value).toBe(330000000);

    store.close();
  });

  it("ignores a non-canonical same-name 'HYPE' token and resolves the canonical spot pair by tokenId", async () => {
    const store = new MarketStore(":memory:");
    const info  = makeMockInfo();
    const poller = new SnapshotPoller(store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, undefined, undefined, undefined, () => Promise.resolve(null));

    await poller.poll();

    const rows = store.getRecentSnapshots("HYPE", 10);
    const metrics = rows[0].metrics;

    // The imposter pair (@105) has markPx 0.091069 — must not be selected.
    expect(metrics.spot_mark_px.value).toBe(25.6);
    expect(metrics.spot_day_ntl_vlm.value).toBe(2000000);
    expect(info.tokenDetails).toHaveBeenCalledWith({ tokenId: CANONICAL_HYPE_TOKEN_ID });

    store.close();
  });

  it("nulls spot-derived metrics when spot_mark_px is more than 20% from perp_mark_px", async () => {
    const store = new MarketStore(":memory:");
    const info  = makeMockInfo();
    // Make the resolved spot pair's price wildly diverge from perp_mark_px (25.5).
    info.spotMetaAndAssetCtxs = vi.fn().mockResolvedValue([
      {
        tokens: [
          { name: "USDC", index: 0, tokenId: "0x00000000000000000000000000000000" },
          { name: "HYPE", index: 150, tokenId: CANONICAL_HYPE_TOKEN_ID },
        ],
        universe: [
          { tokens: [150, 0], index: 107 },
        ],
      },
      [
        { markPx: "0.091069", dayNtlVlm: "1000", coin: "@107" },
      ],
    ]);

    const poller = new SnapshotPoller(store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, undefined, undefined, undefined, () => Promise.resolve(null));
    await poller.poll();

    const rows = store.getRecentSnapshots("HYPE", 10);
    const metrics = rows[0].metrics;

    expect(metrics.perp_mark_px.value).toBe(25.5);
    expect(metrics.spot_mark_px.value).toBeNull();
    expect(metrics.spot_day_ntl_vlm.value).toBeNull();
    expect(metrics.circulating_supply.value).toBeNull();

    store.close();
  });

  it("survives a simulated upstream error without writing a snapshot or throwing", async () => {
    const store = new MarketStore(":memory:");
    const info: MarketInfoClient = {
      metaAndAssetCtxs: vi.fn().mockRejectedValue(new Error("upstream timeout")),
      spotMetaAndAssetCtxs: vi.fn().mockResolvedValue([{ tokens: [], universe: [] }, []]),
      tokenDetails: vi.fn().mockResolvedValue({ circulatingSupply: "0" }),
      l2Book: vi.fn().mockResolvedValue(null),
      validatorSummaries: vi.fn().mockResolvedValue([]),
      spotClearinghouseState: vi.fn().mockResolvedValue({ balances: [] }),
      userFillsByTime: vi.fn().mockResolvedValue([]),
    };
    const poller = new SnapshotPoller(store, { symbols: ["HYPE"] }, info, undefined, undefined, undefined, undefined, () => Promise.resolve(null));

    await expect(poller.poll()).resolves.toBeUndefined();
    expect(store.getRecentSnapshots("HYPE", 10)).toEqual([]);

    store.close();
  });
});

describe("SnapshotPoller — CVD + book microstructure (stage 2)", () => {
  it("writes the 8 CVD/count and 7 book metrics tagged source/kind/captured_at, with book_imbalance in [-1,1]", async () => {
    const store = new MarketStore(":memory:");
    const info  = makeMockInfo();

    const perpWindows = fullWindows({ cvd1h: 12, cvd4h: 48, cvd24h: 288, trades24h: 24 });
    const spotWindows = fullWindows({ cvd1h: -4, cvd4h: -16, cvd24h: -96, trades24h: 8 });
    const aggregators = new Map<string, TradesAggregatorLike>([
      ["HYPE", makeMockAggregator(perpWindows, spotWindows)],
    ]);

    const poller = new SnapshotPoller(store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, aggregators, undefined, undefined, undefined, () => Promise.resolve(null));
    await poller.poll();

    const rows = store.getRecentSnapshots("HYPE", 10);
    const metrics = rows[0].metrics;

    for (const key of [...CVD_KEYS, ...BOOK_KEYS]) {
      expect(metrics[key]).toBeDefined();
      expect(metrics[key].source).toBeTruthy();
      expect(metrics[key].kind).toBeTruthy();
      expect(metrics[key].capturedAt).toBeGreaterThan(0);
      expect(metrics[key].value).not.toBeNull();
    }

    expect(metrics.cvd_perp_1h.value).toBe(12);
    expect(metrics.cvd_perp_trades_24h.value).toBe(24);
    expect(metrics.cvd_spot_1h.value).toBe(-4);
    expect(metrics.cvd_spot_trades_24h.value).toBe(8);

    // Perp book: bid 100@25.49, ask 100@25.51 -> mid 25.50, imbalance 0.
    expect(metrics.book_mid.value).toBeCloseTo(25.50, 5);
    expect(metrics.book_bid_depth.value).toBe(100);
    expect(metrics.book_ask_depth.value).toBe(100);
    expect(metrics.book_imbalance.value).toBeCloseTo(0, 10);

    // Spot book (@107): bid 32.5, ask 67.5 -> imbalance = (32.5-67.5)/100 = -0.35.
    expect(metrics.book_spot_imbalance.value).toBeCloseTo(-0.35, 10);

    for (const key of ["book_imbalance", "book_spot_imbalance"]) {
      expect(metrics[key].value!).toBeGreaterThanOrEqual(-1);
      expect(metrics[key].value!).toBeLessThanOrEqual(1);
    }

    // Spot book resolved from the @-coin, not "HYPE".
    expect(info.l2Book).toHaveBeenCalledWith({ coin: "@107" });

    store.close();
  });

  it("records the filled fraction in meta_json for windowed CVD metrics", async () => {
    const store = new MarketStore(":memory:");
    const info  = makeMockInfo();

    const perpWindows = fullWindows({ cvd1h: 1, filled1h: 0.5, filled4h: 0.5, filled24h: 0.5 });
    const aggregators = new Map<string, TradesAggregatorLike>([
      ["HYPE", makeMockAggregator(perpWindows, null)],
    ]);

    const poller = new SnapshotPoller(store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, aggregators, undefined, undefined, undefined, () => Promise.resolve(null));
    await poller.poll();

    const rows = store.getRecentSnapshots("HYPE", 10);
    const meta = rows[0].metrics.cvd_perp_1h.meta as { filled: number };
    expect(meta.filled).toBeCloseTo(0.5, 10);

    // No spot aggregator data -> spot CVD metrics are null.
    expect(rows[0].metrics.cvd_spot_1h.value).toBeNull();

    store.close();
  });

  it("returns null CVD/book metrics gracefully when no aggregator or book data is available", async () => {
    const store = new MarketStore(":memory:");
    const info  = makeMockInfo();
    info.l2Book = vi.fn().mockResolvedValue(null);

    // No aggregators map injected, and poll() is called directly (without start()),
    // so this.aggregators is empty.
    const poller = new SnapshotPoller(store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, undefined, undefined, undefined, () => Promise.resolve(null));
    await poller.poll();

    const rows = store.getRecentSnapshots("HYPE", 10);
    const metrics = rows[0].metrics;

    for (const key of [...CVD_KEYS, ...BOOK_KEYS]) {
      expect(metrics[key].value).toBeNull();
    }

    store.close();
  });
});

describe("SnapshotPoller — hl-native staking + AF (stage 3)", () => {
  it("writes the 7 hl-native metrics tagged source=hl-native, aggregating validatorSummaries incl. a jailed validator", async () => {
    const store = new MarketStore(":memory:");
    const info  = makeMockInfo();
    const poller = new SnapshotPoller(store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, undefined, undefined, undefined, () => Promise.resolve(null));

    await poller.poll();

    const rows = store.getRecentSnapshots("HYPE", 10);
    const metrics = rows[0].metrics;

    for (const key of HL_NATIVE_KEYS) {
      expect(metrics[key]).toBeDefined();
      expect(metrics[key].source).toBe("hl-native");
      expect(metrics[key].capturedAt).toBeGreaterThan(0);
      expect(metrics[key].value).not.toBeNull();
    }

    // 600M + 400M (non-jailed, active) + 10M jailed/inactive = 1010M total; 1000M active.
    expect(metrics.total_staked_hype.value).toBeCloseTo(1_010_000_000, 5);
    expect(metrics.active_staked_hype.value).toBeCloseTo(1_000_000_000, 5);
    expect(metrics.validator_count.value).toBe(3);
    expect(metrics.af_hype_balance.value).toBeCloseTo(45219365.9, 5);

    expect(info.spotClearinghouseState).toHaveBeenCalledWith({ user: AF_ADDRESS });

    store.close();
  });

  it("counts only AF buy fills for the resolved HYPE spot coin since the previous snapshot", async () => {
    const store = new MarketStore(":memory:");
    const info  = makeMockInfo();

    const T0 = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    info.userFillsByTime = vi.fn()
      .mockResolvedValueOnce([
        { coin: "@107", side: "B", px: "25.0", sz: "100", time: T0 - 120_000 }, // before poll 1's window
        { coin: "@107", side: "B", px: "26.0", sz: "10",  time: T0 - 1_000 },   // within poll 1's window
        { coin: "@107", side: "A", px: "26.0", sz: "999", time: T0 - 1_000 },   // sell - ignored
        { coin: "@255", side: "B", px: "1.0",  sz: "999", time: T0 - 1_000 },   // wrong coin - ignored
      ])
      .mockResolvedValueOnce([
        { coin: "@107", side: "B", px: "27.0", sz: "5", time: T0 + 30_000 },    // within poll 2's window
        { coin: "@107", side: "B", px: "27.0", sz: "1", time: T0 - 1_000 },     // before poll 2's window
      ]);

    try {
      const poller = new SnapshotPoller(store, { symbols: ["HYPE"], pollIntervalMs: 60_000, retentionRawDays: 7 }, info, undefined, undefined, undefined, undefined, () => Promise.resolve(null));

      await poller.poll();
      expect(info.userFillsByTime).toHaveBeenNthCalledWith(1, { user: AF_ADDRESS, startTime: T0 - 60_000 });
      let metrics = store.getRecentSnapshots("HYPE", 10)[0].metrics;
      expect(metrics.af_buy_fills.value).toBe(1);
      expect(metrics.af_buy_hype_window.value).toBeCloseTo(10, 10);
      expect(metrics.af_buy_usdc_window.value).toBeCloseTo(260, 10);

      vi.setSystemTime(T0 + 60_000);
      await poller.poll();
      expect(info.userFillsByTime).toHaveBeenNthCalledWith(2, { user: AF_ADDRESS, startTime: T0 });
      metrics = store.getRecentSnapshots("HYPE", 10)[0].metrics;
      expect(metrics.af_buy_fills.value).toBe(1);
      expect(metrics.af_buy_hype_window.value).toBeCloseTo(5, 10);
      expect(metrics.af_buy_usdc_window.value).toBeCloseTo(135, 10);
    } finally {
      vi.useRealTimers();
      store.close();
    }
  });

  it("does not implement compute() for any stage-3b metric (unstake queue, TWAP, native liqs)", () => {
    const implemented = getImplementedMetrics().map((m) => m.key);
    for (const key of STAGE_3B_KEYS) {
      expect(implemented).not.toContain(key);
    }
  });

  it("poller integration: stage-3b stub keys never appear in a written snapshot", async () => {
    const store = new MarketStore(":memory:");
    const info  = makeMockInfo();
    const poller = new SnapshotPoller(store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, undefined, undefined, undefined, () => Promise.resolve(null));

    await poller.poll();

    const metrics = store.getRecentSnapshots("HYPE", 10)[0].metrics;
    for (const key of STAGE_3B_KEYS) {
      expect(metrics[key]).toBeUndefined();
    }

    store.close();
  });
});
