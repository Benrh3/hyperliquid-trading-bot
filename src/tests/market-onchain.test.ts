/**
 * Tests for the on-chain CEX-flow + holder-concentration source (stage 5,
 * market-spec.md §7). Covers the pure aggregation helpers (no I/O) and
 * SnapshotPoller integration: empty wallet list (the default, safe no-op),
 * a mock 2-3 wallet list (aggregate balance, signed flow deltas, cold-start
 * nulling, failed-read exclusion), layer routing, and holder math.
 */

import { describe, it, expect, vi } from "vitest";
import { MarketStore } from "../market/store.js";
import { SnapshotPoller, type MarketInfoClient } from "../market/poller.js";
import { aggregateBalances, computeFlows, computeHolderMetrics, type WalletRead } from "../market/onchain/flows.js";
import { isPlaceholderAddress, type CexWalletsConfig, type OnChainBalanceReader, type HolderDistribution } from "../market/onchain/types.js";

const CANONICAL_HYPE_TOKEN_ID = "0x0d01dc56dcaaca66ad901c959b4011ec";
const CANONICAL_HYPE_TOKEN_INDEX = 150;

const ON_CHAIN_KEYS = [
  "cex_inflow_hype", "cex_outflow_hype", "cex_net_flow_hype", "cex_net_flow_usdc",
  "cex_total_balance_hype", "cex_wallets_polled",
  "holders_count", "holder_supply_ex_system", "holder_top10_share", "holder_top50_share", "holder_top100_share",
];

function makeMockInfo(): MarketInfoClient {
  return {
    metaAndAssetCtxs: vi.fn().mockResolvedValue([
      { universe: [{ name: "HYPE" }] },
      [{ markPx: "25.0", oraclePx: "25.0", funding: "0.0001", openInterest: "1000000", premium: "0.0008", dayNtlVlm: "5000000" }],
    ]),
    spotMetaAndAssetCtxs: vi.fn().mockResolvedValue([
      {
        tokens: [
          { name: "USDC", index: 0, tokenId: "0x00000000000000000000000000000000" },
          { name: "HYPE", index: CANONICAL_HYPE_TOKEN_INDEX, tokenId: CANONICAL_HYPE_TOKEN_ID },
        ],
        universe: [{ tokens: [CANONICAL_HYPE_TOKEN_INDEX, 0], index: 107 }],
      },
      [{ markPx: "25.0", dayNtlVlm: "2000000", coin: "@107" }],
    ]),
    tokenDetails: vi.fn().mockResolvedValue({ circulatingSupply: "330000000" }),
    l2Book: vi.fn().mockResolvedValue(null),
    validatorSummaries: vi.fn().mockResolvedValue([]),
    spotClearinghouseState: vi.fn().mockResolvedValue({ balances: [] }),
    userFillsByTime: vi.fn().mockResolvedValue([]),
  };
}

const EMPTY_WALLETS_CONFIG: CexWalletsConfig = {
  asset: "HYPE",
  wallets: [],
  systemWallets: [{ address: "0x2222222222222222222222222222222222222222", label: "HyperCore<>EVM bridge" }],
};

function nullHolderDist(): Promise<HolderDistribution | null> {
  return Promise.resolve(null);
}

// ── Pure helper tests ───────────────────────────────────────────────────────

describe("isPlaceholderAddress", () => {
  it("treats the zero address as a placeholder", () => {
    expect(isPlaceholderAddress("0x00000000000000000000000000000000000000")).toBe(true);
    expect(isPlaceholderAddress("0x0000000000000000000000000000000000dEaD")).toBe(false);
  });

  it("treats a real-looking address as not a placeholder", () => {
    expect(isPlaceholderAddress("0x2222222222222222222222222222222222222222")).toBe(false);
  });
});

describe("aggregateBalances", () => {
  it("sums successful reads and counts them, excluding failed (null) reads", () => {
    const reads: WalletRead[] = [
      { address: "0xa", balance: 100 },
      { address: "0xb", balance: null }, // failed read
      { address: "0xc", balance: 50 },
    ];
    const agg = aggregateBalances(reads);
    expect(agg.total).toBe(150);
    expect(agg.walletsPolled).toBe(2);
    expect(agg.perWallet.get("0xa")).toBe(100);
    expect(agg.perWallet.has("0xb")).toBe(false);
  });

  it("returns null total and walletsPolled=0 for an empty list", () => {
    const agg = aggregateBalances([]);
    expect(agg.total).toBeNull();
    expect(agg.walletsPolled).toBe(0);
  });

  it("returns null total and walletsPolled=0 when every read fails", () => {
    const agg = aggregateBalances([{ address: "0xa", balance: null }, { address: "0xb", balance: null }]);
    expect(agg.total).toBeNull();
    expect(agg.walletsPolled).toBe(0);
  });
});

describe("computeFlows", () => {
  it("returns null deltas on cold start (no previous balances)", () => {
    const current = new Map([["0xa", 100]]);
    expect(computeFlows(current, null)).toEqual({ netFlow: null, inflow: null, outflow: null });
    expect(computeFlows(current, new Map())).toEqual({ netFlow: null, inflow: null, outflow: null });
  });

  it("computes signed net/inflow/outflow from per-wallet deltas", () => {
    const previous = new Map([["0xa", 100], ["0xb", 200]]);
    const current  = new Map([["0xa", 150], ["0xb", 180]]); // +50, -20
    const flows = computeFlows(current, previous);
    expect(flows.inflow).toBe(50);
    expect(flows.outflow).toBe(20);
    expect(flows.netFlow).toBe(30);
  });

  it("returns null when no wallet has both a current and previous reading", () => {
    const previous = new Map([["0xa", 100]]);
    const current  = new Map([["0xb", 200]]);
    expect(computeFlows(current, previous)).toEqual({ netFlow: null, inflow: null, outflow: null });
  });
});

describe("computeHolderMetrics", () => {
  it("computes holdersCount, supplyExSystem, and topN shares excluding system wallets", () => {
    const dist: HolderDistribution = {
      holdersCount: 5,
      balances: new Map([
        ["0xbridge", 1000], // system wallet — excluded
        ["0xwhale1", 400],
        ["0xwhale2", 300],
        ["0xsmall1", 200],
        ["0xsmall2", 100],
      ]),
    };
    const metrics = computeHolderMetrics(dist, new Set(["0xbridge"]));
    expect(metrics.holdersCount).toBe(5);
    // total non-system supply = 400+300+200+100 = 1000
    expect(metrics.supplyExSystem).toBe(1000);
    expect(metrics.top10Share).toBe(1); // only 4 non-system holders, all in top10
    expect(metrics.top50Share).toBe(1);
    expect(metrics.top100Share).toBe(1);
  });

  it("returns null shares when supplyExSystem is zero", () => {
    const dist: HolderDistribution = { holdersCount: 1, balances: new Map([["0xbridge", 1000]]) };
    const metrics = computeHolderMetrics(dist, new Set(["0xbridge"]));
    expect(metrics.supplyExSystem).toBe(0);
    expect(metrics.top10Share).toBeNull();
    expect(metrics.top50Share).toBeNull();
    expect(metrics.top100Share).toBeNull();
  });
});

// ── SnapshotPoller integration tests ────────────────────────────────────────

describe("SnapshotPoller — on-chain (stage 5), empty wallet list (default)", () => {
  it("nulls all six flow/balance metrics, wallets_polled=0, tagged source=on-chain, never throws", async () => {
    const store = new MarketStore(":memory:");
    const info = makeMockInfo();

    const balanceReader: OnChainBalanceReader = {
      readHypercoreBalance: vi.fn().mockResolvedValue(null),
      readHyperevmBalance: vi.fn().mockResolvedValue(null),
    };

    const poller = new SnapshotPoller(
      store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, undefined,
      EMPTY_WALLETS_CONFIG, balanceReader, nullHolderDist,
    );
    await poller.poll();

    const metrics = store.getRecentSnapshots("HYPE", 10)[0].metrics;
    for (const key of ON_CHAIN_KEYS) {
      expect(metrics[key]).toBeDefined();
      expect(metrics[key].source).toBe("on-chain");
    }

    for (const key of ["cex_inflow_hype", "cex_outflow_hype", "cex_net_flow_hype", "cex_net_flow_usdc", "cex_total_balance_hype"]) {
      expect(metrics[key].value).toBeNull();
    }
    expect(metrics.cex_wallets_polled.value).toBe(0);

    expect(balanceReader.readHypercoreBalance).not.toHaveBeenCalled();
    expect(balanceReader.readHyperevmBalance).not.toHaveBeenCalled();

    store.close();
  });

  it("holder metrics are null when the holder-distribution fetch fails", async () => {
    const store = new MarketStore(":memory:");
    const info = makeMockInfo();

    const balanceReader: OnChainBalanceReader = {
      readHypercoreBalance: vi.fn().mockResolvedValue(null),
      readHyperevmBalance: vi.fn().mockResolvedValue(null),
    };

    const poller = new SnapshotPoller(
      store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, undefined,
      EMPTY_WALLETS_CONFIG, balanceReader, nullHolderDist,
    );
    await poller.poll();

    const metrics = store.getRecentSnapshots("HYPE", 10)[0].metrics;
    for (const key of ["holders_count", "holder_supply_ex_system", "holder_top10_share", "holder_top50_share", "holder_top100_share"]) {
      expect(metrics[key].value).toBeNull();
    }

    store.close();
  });
});

describe("SnapshotPoller — on-chain (stage 5), populated wallet list", () => {
  const walletsConfig: CexWalletsConfig = {
    asset: "HYPE",
    wallets: [
      { address: "0xCoreWallet", label: "core wallet", layer: "hypercore" },
      { address: "0xEvmWallet", label: "evm wallet", layer: "hyperevm" },
      { address: "0xFailWallet", label: "fails", layer: "hyperevm" },
      { address: "0x0000000000000000000000000000000000000000", label: "placeholder", layer: "hyperevm" },
    ],
    systemWallets: [{ address: "0x2222222222222222222222222222222222222222", label: "bridge" }],
  };

  function makeBalanceReader(round: 1 | 2): OnChainBalanceReader {
    return {
      readHypercoreBalance: vi.fn(async (address: string) => {
        if (address === "0xCoreWallet") return round === 1 ? 100 : 150; // +50
        return null;
      }),
      readHyperevmBalance: vi.fn(async (address: string) => {
        if (address === "0xEvmWallet") return round === 1 ? 200 : 180; // -20
        if (address === "0xFailWallet") return null; // always fails
        return null;
      }),
    };
  }

  const HOLDER_DIST: HolderDistribution = {
    holdersCount: 5,
    balances: new Map([
      ["0x2222222222222222222222222222222222222222", 1000], // system
      ["0xwhale1", 400],
      ["0xwhale2", 300],
      ["0xsmall1", 200],
      ["0xsmall2", 100],
    ]),
  };

  it("first poll: cold start nulls flow deltas, computes aggregate balance and wallets_polled excluding the failed read and placeholder", async () => {
    const store = new MarketStore(":memory:");
    const info = makeMockInfo();
    const balanceReader = makeBalanceReader(1);

    const poller = new SnapshotPoller(
      store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, undefined,
      walletsConfig, balanceReader, () => Promise.resolve(HOLDER_DIST),
    );
    await poller.poll();

    const metrics = store.getRecentSnapshots("HYPE", 10)[0].metrics;

    // 100 (hypercore) + 200 (hyperevm) = 300; fail + placeholder excluded
    expect(metrics.cex_total_balance_hype.value).toBe(300);
    expect(metrics.cex_wallets_polled.value).toBe(2);

    // cold start — no previous balances
    expect(metrics.cex_net_flow_hype.value).toBeNull();
    expect(metrics.cex_inflow_hype.value).toBeNull();
    expect(metrics.cex_outflow_hype.value).toBeNull();
    expect(metrics.cex_net_flow_usdc.value).toBeNull();

    // placeholder address never read
    expect(balanceReader.readHyperevmBalance).not.toHaveBeenCalledWith("0x0000000000000000000000000000000000000000");

    // holder metrics computed from the mock distribution
    expect(metrics.holders_count.value).toBe(5);
    expect(metrics.holder_supply_ex_system.value).toBe(1000); // 400+300+200+100
    expect(metrics.holder_top10_share.value).toBe(1);

    store.close();
  });

  it("second poll: computes signed flow deltas vs the first poll's balances", async () => {
    const store = new MarketStore(":memory:");
    const info = makeMockInfo();

    const poller = new SnapshotPoller(
      store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, undefined,
      walletsConfig, makeBalanceReader(1), () => Promise.resolve(HOLDER_DIST),
    );
    await poller.poll(); // cold start

    // Swap in round-2 balances for the second poll.
    (poller as unknown as { balanceReader: OnChainBalanceReader }).balanceReader = makeBalanceReader(2);
    await poller.poll();

    const metrics = store.getRecentSnapshots("HYPE", 10)[0].metrics;

    // hypercore wallet +50, hyperevm wallet -20 -> net +30, inflow 50, outflow 20
    expect(metrics.cex_net_flow_hype.value).toBe(30);
    expect(metrics.cex_inflow_hype.value).toBe(50);
    expect(metrics.cex_outflow_hype.value).toBe(20);
    // net_flow_usdc = netFlow * markPx (markPx=25.0 from makeMockInfo)
    expect(metrics.cex_net_flow_usdc.value).toBe(750);

    expect(metrics.cex_total_balance_hype.value).toBe(330); // 150 + 180
    expect(metrics.cex_wallets_polled.value).toBe(2);

    store.close();
  });

  it("layer routing: hypercore wallets use spotClearinghouseState-backed reader, hyperevm wallets use the RPC-backed reader", async () => {
    const store = new MarketStore(":memory:");
    const info = makeMockInfo();
    const balanceReader = makeBalanceReader(1);

    const poller = new SnapshotPoller(
      store, { symbols: ["HYPE"], retentionRawDays: 7 }, info, undefined, undefined,
      walletsConfig, balanceReader, () => Promise.resolve(HOLDER_DIST),
    );
    await poller.poll();

    expect(balanceReader.readHypercoreBalance).toHaveBeenCalledWith("0xCoreWallet");
    expect(balanceReader.readHypercoreBalance).not.toHaveBeenCalledWith("0xEvmWallet");
    expect(balanceReader.readHyperevmBalance).toHaveBeenCalledWith("0xEvmWallet");
    expect(balanceReader.readHyperevmBalance).toHaveBeenCalledWith("0xFailWallet");
    expect(balanceReader.readHyperevmBalance).not.toHaveBeenCalledWith("0xCoreWallet");

    store.close();
  });
});
