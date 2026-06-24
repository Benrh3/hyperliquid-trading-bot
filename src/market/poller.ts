// Snapshot poller for the Market data subsystem (market-spec.md §7 stages 1-3).
//
// Mirrors FundingMatrixPoller's poll→persist→retention structure, but is
// observe-only and runs as its own PM2 process ('snapshot-poller'). Reads
// mainnet via the market-data-network resolver, independent of
// config.exchange.network (trading execution).

import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { getMarketDataNetwork, getMarketDataHlIsTestnet } from "./network.js";
import { getImplementedMetrics, metricAppliesTo, safeNum, type MarketPollContext } from "./registry.js";
import type { MarketStore, MetricInput } from "./store.js";
import { TradesAggregator, type CoinWindows } from "./tradesAggregator.js";
import { computePerpBookMetrics, computeSpotBookMetrics, type L2BookLike } from "./book.js";
import {
  computeStakingMetrics, computeAfMetrics,
  type ValidatorSummaryLike, type SpotBalanceLike, type AfFillLike,
  type StakingMetrics, type AfMetrics,
} from "./hlNative.js";
import { BinanceSource } from "./cex/binance.js";
import { BybitSource } from "./cex/bybit.js";
import { OkxSource } from "./cex/okx.js";
import type { CexDerivsSource, LongShortRatios } from "./cex/types.js";
import { CexLiqTracker, type CexLiqWindows } from "./cex/liqTracker.js";
import { computeOiTotal, computeAggLongFrac, aggregateLiqWindows } from "./cex/aggregate.js";
import { loadCexWalletsConfig, bootstrapCexWalletsConfig } from "./onchain/wallets.js";
import { DefaultOnChainBalanceReader } from "./onchain/balanceReader.js";
import { aggregateBalances, computeFlows, computeHolderMetrics } from "./onchain/flows.js";
import { fetchHolderDistribution } from "./onchain/hypurrscan.js";
import { isPlaceholderAddress, type CexWalletsConfig, type OnChainBalanceReader, type HolderDistribution, type HolderMetrics } from "./onchain/types.js";
import { computeDerived, type DerivedValues } from "./derived.js";
import type { SnapshotRow } from "./store.js";

const DEFAULT_POLL_INTERVAL_MS  = 3_600_000;
const DEFAULT_RETENTION_RAW_DAYS = 7;

// Max fractional difference allowed between spot_mark_px and perp_mark_px
// before the resolved spot pair is treated as suspect (see SPOT_PRICE_GUARD_PCT).
const SPOT_PRICE_GUARD_PCT = 0.20;

// The metric keys that depend on the resolved spot pair / canonical token —
// all three are nulled together if the price guard trips.
const SPOT_DERIVED_METRIC_KEYS = ["spot_mark_px", "spot_day_ntl_vlm", "circulating_supply"];

/**
 * tokenId of Hyperliquid's native HYPE asset on mainnet spot
 * (spotMeta.tokens[].tokenId, index 150, evmContract: null — native gas
 * tokens aren't ERC20s). Verified via the tokenDetails endpoint: maxSupply
 * 1,000,000,000, markPx tracks the HYPE perp price.
 *
 * Hyperliquid's spot listings are permissionless, so multiple tokens can
 * share the display name "HYPE" (e.g. meme deploys). Resolving by this
 * tokenId — not by name — is what avoids picking an imposter.
 */
const CANONICAL_SPOT_TOKEN_IDS: Record<string, string> = {
  HYPE: "0x0d01dc56dcaaca66ad901c959b4011ec",
};

/**
 * Hyperliquid Assistance Fund system address — receives ~97% of protocol
 * trading fees, auto-converted to HYPE. Has no private key. Labeled
 * "Assistance Fund" on HypurrScan: https://hypurrscan.io/address/0xfefefefefefefefefefefefefefefefefefefefe
 */
const AF_ADDRESS = "0xfefefefefefefefefefefefefefefefefefefefe";

/** Manifest keys implemented by readHlNative() — all hype-only. */
const HL_NATIVE_KEYS = [
  "total_staked_hype", "active_staked_hype", "validator_count",
  "af_hype_balance", "af_buy_hype_window", "af_buy_usdc_window", "af_buy_fills",
];

const NULL_LSR: LongShortRatios = { accountRatio: null, topPositionRatio: null, takerRatio: null };

/** How often the (large, ~14MB) holder distribution is refetched, independent of pollIntervalMs. Matches the manifest's staleAfterMs (65min) for holder metrics. */
const HOLDER_REFRESH_MS = 60 * 60 * 1000;

/** Per-symbol set of CEX venue adapters — see src/market/cex/types.ts (CexDerivsSource). */
export interface CexVenueSources {
  binance: CexDerivsSource;
  bybit:   CexDerivsSource;
  okx:     CexDerivsSource;
}

export interface SnapshotPollerConfig {
  symbols?:          string[];
  pollIntervalMs?:   number;
  retentionRawDays?: number;
}

/** Minimal subset of InfoClient used by the poller — lets tests pass a mock. */
export interface MarketInfoClient {
  metaAndAssetCtxs(): Promise<[
    { universe: { name: string }[] },
    { markPx: string; oraclePx: string; funding: string; openInterest: string; premium: string | null; dayNtlVlm: string }[],
  ]>;
  spotMetaAndAssetCtxs(): Promise<[
    { tokens: { name: string; index: number; tokenId: string }[]; universe: { tokens: number[]; index: number }[] },
    { markPx: string; dayNtlVlm: string; coin: string }[],
  ]>;
  tokenDetails(params: { tokenId: string }): Promise<{ circulatingSupply: string }>;
  l2Book(params: { coin: string }): Promise<L2BookLike | null>;
  validatorSummaries(): Promise<ValidatorSummaryLike[]>;
  spotClearinghouseState(params: { user: string }): Promise<{ balances: SpotBalanceLike[] }>;
  userFillsByTime(params: { user: string; startTime: number }): Promise<AfFillLike[]>;
}

type SpotMeta = Awaited<ReturnType<MarketInfoClient["spotMetaAndAssetCtxs"]>>[0];
type SpotCtx  = Awaited<ReturnType<MarketInfoClient["spotMetaAndAssetCtxs"]>>[1][number];

/** Minimal interface for an injectable trades aggregator — TradesAggregator implements this. */
export interface TradesAggregatorLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  getPerpWindows(): CoinWindows;
  getSpotWindows(): CoinWindows | null;
  persistTrackers?(): void;
}

/**
 * Resolve the canonical spot pair ctx for `symbol`, plus the canonical
 * token's tokenId (for the tokenDetails circulating-supply lookup).
 *
 * Steps (see CANONICAL_SPOT_TOKEN_IDS for why tokenId, not name):
 *  1. Find the spot token whose tokenId matches the known canonical id.
 *  2. Find the [token, USDC] pair in spotMeta.universe (USDC = token index 0).
 *  3. assetCtxs is NOT positionally parallel to universe — match by the
 *     `coin` field, which is "@<pair.index>". This is also the spot coin id
 *     used for the trades WS subscription and l2Book poll (e.g. "@107") —
 *     callers should read it from the returned ctx.coin, never hardcode it.
 *
 * `tokenIndex` (spotMeta.tokens[].index, e.g. 150 for HYPE) is also returned —
 * it's how AF balances are matched in spotClearinghouseState (which keys
 * balances by `token` index, not by the possibly-ambiguous `coin` name).
 */
export function resolveSpotPair(
  symbol: string,
  spotMeta: SpotMeta,
  spotCtxs: SpotCtx[],
): { ctx: SpotCtx | null; tokenId: string | null; tokenIndex: number | null } {
  const expectedTokenId = CANONICAL_SPOT_TOKEN_IDS[symbol];
  if (!expectedTokenId) return { ctx: null, tokenId: null, tokenIndex: null };

  const token = spotMeta.tokens.find((t) => t.tokenId === expectedTokenId);
  if (!token) return { ctx: null, tokenId: null, tokenIndex: null };

  const pair = spotMeta.universe.find((p) => p.tokens.length === 2 && p.tokens[0] === token.index && p.tokens[1] === 0);
  if (!pair) return { ctx: null, tokenId: token.tokenId, tokenIndex: token.index };

  const ctx = spotCtxs.find((c) => c.coin === `@${pair.index}`) ?? null;
  return { ctx, tokenId: token.tokenId, tokenIndex: token.index };
}

export class SnapshotPoller {
  private readonly store:       MarketStore;
  private readonly info:        MarketInfoClient;
  private readonly symbols:     string[];
  private readonly pollIntervalMs:   number;
  private readonly retentionRawDays: number;
  private readonly dataNetwork: "mainnet" | "testnet";
  private readonly aggregators: Map<string, TradesAggregatorLike>;
  private readonly aggregatorsInjected: boolean;
  private readonly cexSources: Map<string, CexVenueSources>;
  private readonly cexLiqTrackers = new Map<string, Map<string, CexLiqTracker>>();
  private spotCoinBySymbol = new Map<string, string | null>();
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly walletsConfig: CexWalletsConfig;
  private readonly balanceReader: OnChainBalanceReader;
  private readonly fetchHolderDist: () => Promise<HolderDistribution | null>;
  /** Per-symbol map of address -> balance from the previous poll, for flow-delta computation. Null until the first successful read. */
  private prevBalances = new Map<string, Map<string, number>>();
  private holderCache: { metrics: HolderMetrics; fetchedAt: number } | null = null;

  constructor(
    store: MarketStore,
    config: SnapshotPollerConfig = {},
    info?: MarketInfoClient,
    aggregators?: Map<string, TradesAggregatorLike>,
    cexSources?: Map<string, CexVenueSources>,
    walletsConfig?: CexWalletsConfig,
    balanceReader?: OnChainBalanceReader,
    fetchHolderDist?: () => Promise<HolderDistribution | null>,
  ) {
    this.store            = store;
    this.symbols          = config.symbols ?? ["HYPE"];
    this.pollIntervalMs   = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.retentionRawDays = config.retentionRawDays ?? DEFAULT_RETENTION_RAW_DAYS;

    this.dataNetwork = getMarketDataNetwork();
    if (info) {
      this.info = info;
    } else {
      const hlIsTestnet = getMarketDataHlIsTestnet(this.dataNetwork);
      this.info = new InfoClient({ transport: new HttpTransport({ isTestnet: hlIsTestnet }) });
    }

    this.aggregatorsInjected = !!aggregators;
    this.aggregators = aggregators ?? new Map();

    this.cexSources = cexSources ?? new Map();
    if (!cexSources) {
      for (const symbol of this.symbols) {
        this.cexSources.set(symbol, { binance: new BinanceSource(), bybit: new BybitSource(), okx: new OkxSource() });
      }
    }
    for (const symbol of this.symbols) {
      this.cexLiqTrackers.set(symbol, new Map([
        ["binance", new CexLiqTracker()],
        ["bybit", new CexLiqTracker()],
        ["okx", new CexLiqTracker()],
      ]));
    }

    if (walletsConfig) {
      this.walletsConfig = walletsConfig;
    } else {
      bootstrapCexWalletsConfig();
      this.walletsConfig = loadCexWalletsConfig();
    }
    this.balanceReader = balanceReader ?? new DefaultOnChainBalanceReader(this.info);
    this.fetchHolderDist = fetchHolderDist ?? (() => fetchHolderDistribution());

    console.log(
      `[snapshot-poller] Data network: ${this.dataNetwork}, symbols: ${this.symbols.join(", ")}, ` +
      `interval: ${this.pollIntervalMs / 1000}s`,
    );
  }

  async start(): Promise<void> {
    await this.resolveSpotCoins();

    if (!this.aggregatorsInjected) {
      for (const symbol of this.symbols) {
        if (this.aggregators.has(symbol)) continue;
        this.aggregators.set(symbol, new TradesAggregator(symbol, this.spotCoinBySymbol.get(symbol) ?? null, undefined, this.store));
      }
    }
    await Promise.all([...this.aggregators.values()].map((a) => a.start()));

    await this.resolveCexSymbols();
    this.startCexLiqStreams();

    await this.poll(); // initial fill before the timer fires
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    console.log(`[snapshot-poller] Poller started`);
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await Promise.all([...this.aggregators.values()].map((a) => a.stop()));
    for (const sources of this.cexSources.values()) {
      sources.binance.stopLiquidationStream();
      sources.bybit.stopLiquidationStream();
      sources.okx.stopLiquidationStream();
    }
  }

  /** Resolve each symbol's per-venue CEX instrument (symbol/instId). Unlisted venues stay unavailable. Never throws. */
  private async resolveCexSymbols(): Promise<void> {
    await Promise.all(
      [...this.cexSources.entries()].map(([symbol, sources]) =>
        Promise.all([
          sources.binance.resolveSymbol(symbol),
          sources.bybit.resolveSymbol(symbol),
          sources.okx.resolveSymbol(symbol),
        ]),
      ),
    );
  }

  /** Start each available venue's liquidation stream, feeding its CexLiqTracker. Defensive reconnect lives in ReconnectingLiqStream. */
  private startCexLiqStreams(): void {
    for (const [symbol, sources] of this.cexSources) {
      const trackers = this.cexLiqTrackers.get(symbol)!;
      for (const [venueName, source] of Object.entries(sources) as [keyof CexVenueSources, CexDerivsSource][]) {
        if (!source.isAvailable()) continue;
        const tracker = trackers.get(venueName)!;
        source.startLiquidationStream((event) => tracker.recordLiq(event.side, event.notionalUsd, event.timeMs));
      }
    }
  }

  /** Resolve each symbol's spot coin id (e.g. "@107") so the trades aggregator can subscribe to it. */
  private async resolveSpotCoins(): Promise<void> {
    try {
      const [spotMeta, spotCtxs] = await this.info.spotMetaAndAssetCtxs();
      for (const symbol of this.symbols) {
        const { ctx } = resolveSpotPair(symbol, spotMeta, spotCtxs);
        this.spotCoinBySymbol.set(symbol, ctx?.coin ?? null);
      }
    } catch (e) {
      console.warn(`[snapshot-poller] Failed to resolve spot coins: ${(e as Error).message}`);
    }
  }

  /** One poll cycle: fetch ctxs + books, compute implemented metrics, persist per symbol. */
  async poll(): Promise<void> {
    let perpData: Awaited<ReturnType<MarketInfoClient["metaAndAssetCtxs"]>> | null = null;
    let spotData: Awaited<ReturnType<MarketInfoClient["spotMetaAndAssetCtxs"]>> | null = null;

    try {
      [perpData, spotData] = await Promise.all([
        this.info.metaAndAssetCtxs(),
        this.info.spotMetaAndAssetCtxs(),
      ]);
    } catch (e) {
      console.warn(`[snapshot-poller] Poll failed: ${(e as Error).message}`);
      return;
    }

    const [perpMeta, perpCtxs] = perpData;
    const [spotMeta, spotCtxs] = spotData;
    const capturedAt = Date.now();
    const implemented = getImplementedMetrics();

    for (const symbol of this.symbols) {
      const perpIndex = perpMeta.universe.findIndex((u) => u.name === symbol);
      if (perpIndex === -1) {
        console.warn(`[snapshot-poller] ${symbol} not found in perp universe — skipping`);
        continue;
      }
      const perpCtx = perpCtxs[perpIndex];

      const { ctx: spotCtxRaw, tokenId, tokenIndex } = resolveSpotPair(symbol, spotMeta, spotCtxs);
      const spotCtx = spotCtxRaw ? { markPx: spotCtxRaw.markPx, dayNtlVlm: spotCtxRaw.dayNtlVlm } : null;
      const spotCoinId = spotCtxRaw?.coin ?? null;

      let circulatingSupply: string | null = null;
      const needsCirculatingSupply = implemented.some(
        (m) => m.key === "circulating_supply" && metricAppliesTo(m, symbol),
      );
      if (tokenId && needsCirculatingSupply) {
        try {
          circulatingSupply = (await this.info.tokenDetails({ tokenId })).circulatingSupply;
        } catch (e) {
          console.warn(`[snapshot-poller] tokenDetails failed for ${symbol}: ${(e as Error).message}`);
        }
      }

      // Fetch the previous snapshot once — shared by fetchHlNative (AF fills window) and fetchDerived.
      const [prevSnap] = this.store.getRecentSnapshots(symbol, 1);

      const { cvd, cvdMeta } = this.readCvdWindows(symbol);
      const book = await this.pollBook(symbol, spotCoinId);

      let hlNative: MarketPollContext["hlNative"] = null;
      const needsHlNative = implemented.some((m) => HL_NATIVE_KEYS.includes(m.key) && metricAppliesTo(m, symbol));
      if (needsHlNative) {
        hlNative = await this.fetchHlNative(symbol, spotCoinId, tokenIndex, capturedAt, prevSnap);
      }

      let cex: MarketPollContext["cex"] = null;
      let cexLiqMeta: Record<string, { filled: number }> = {};
      const needsCex = implemented.some((m) => m.source === "cex-agg" && metricAppliesTo(m, symbol));
      if (needsCex) {
        ({ cex, cexLiqMeta } = await this.fetchCex(symbol));
      }

      let onChain: MarketPollContext["onChain"] = null;
      const needsOnChain = implemented.some((m) => m.source === "on-chain" && metricAppliesTo(m, symbol));
      if (needsOnChain) {
        onChain = await this.fetchOnChain(symbol, perpCtx.markPx);
      }

      // Build the partial context (without derived) so fetchDerived can inspect it.
      const partialCtx = { symbol, perpCtx, spotCtx, circulatingSupply, cvd, book, hlNative, cex, onChain };
      const derived = this.fetchDerived(partialCtx, prevSnap, capturedAt);

      const ctx: MarketPollContext = { ...partialCtx, derived };

      const metrics: MetricInput[] = [];
      for (const metric of implemented) {
        if (!metricAppliesTo(metric, symbol)) continue;
        const value = metric.compute!(ctx);
        const meta = cvdMeta[metric.key] ?? cexLiqMeta[metric.key];
        metrics.push({ key: metric.key, value, source: metric.source, kind: metric.kind, ...(meta !== undefined ? { meta } : {}) });
      }

      this.applySpotPriceGuard(symbol, metrics);
      this.store.writeSnapshot(symbol, this.dataNetwork, capturedAt, metrics);

      // Persist CVD tracker state so it survives restarts
      const agg = this.aggregators.get(symbol);
      if (agg?.persistTrackers && !this.aggregatorsInjected) agg.persistTrackers();
    }

    this.store.runRetentionPolicy(this.retentionRawDays);
  }

  /** Read the trades aggregator's current CVD/trade-count windows for `symbol`, plus filled-fraction meta. */
  private readCvdWindows(symbol: string): { cvd: MarketPollContext["cvd"]; cvdMeta: Record<string, { filled: number }> } {
    const agg = this.aggregators.get(symbol);
    if (!agg) return { cvd: null, cvdMeta: {} };

    const perp = agg.getPerpWindows();
    const spot = agg.getSpotWindows();

    // Gate CVD values on filled fraction — suppress windows that aren't mostly warm
    // to prevent all three windows from showing the same (partial) value after restart.
    const MIN_FILLED = 0.8;
    const gateN = (v: number, filled: number): number | null => filled >= MIN_FILLED ? v : null;

    const cvd: MarketPollContext["cvd"] = {
      perp: {
        cvd1h:     gateN(perp.cvd1h, perp.filled1h),
        cvd4h:     gateN(perp.cvd4h, perp.filled4h),
        cvd24h:    gateN(perp.cvd24h, perp.filled24h),
        trades24h: gateN(perp.trades24h, perp.filled24h),
      },
      spot: spot ? {
        cvd1h:     gateN(spot.cvd1h, spot.filled1h),
        cvd4h:     gateN(spot.cvd4h, spot.filled4h),
        cvd24h:    gateN(spot.cvd24h, spot.filled24h),
        trades24h: gateN(spot.trades24h, spot.filled24h),
      } : null,
    };

    const cvdMeta: Record<string, { filled: number }> = {
      cvd_perp_1h:         { filled: perp.filled1h },
      cvd_perp_4h:         { filled: perp.filled4h },
      cvd_perp_24h:        { filled: perp.filled24h },
      cvd_perp_trades_24h: { filled: perp.filled24h },
    };
    if (spot) {
      cvdMeta.cvd_spot_1h         = { filled: spot.filled1h };
      cvdMeta.cvd_spot_4h         = { filled: spot.filled4h };
      cvdMeta.cvd_spot_24h        = { filled: spot.filled24h };
      cvdMeta.cvd_spot_trades_24h = { filled: spot.filled24h };
    }

    return { cvd, cvdMeta };
  }

  /** Point-in-time l2Book poll for the perp coin and (if resolved) the spot coin. Never throws. */
  private async pollBook(symbol: string, spotCoinId: string | null): Promise<MarketPollContext["book"]> {
    const [perpBook, spotBook] = await Promise.all([
      this.fetchBook(symbol),
      spotCoinId ? this.fetchBook(spotCoinId) : Promise.resolve(null),
    ]);
    return {
      perp: computePerpBookMetrics(perpBook),
      spot: computeSpotBookMetrics(spotBook),
    };
  }

  private async fetchBook(coin: string): Promise<L2BookLike | null> {
    try {
      return await this.info.l2Book({ coin });
    } catch (e) {
      console.warn(`[snapshot-poller] l2Book failed for ${coin}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Staking (validatorSummaries) + Assistance Fund (AF address balance/fills). Never throws. */
  private async fetchHlNative(
    symbol: string,
    spotCoinId: string | null,
    tokenIndex: number | null,
    capturedAt: number,
    prevSnap: SnapshotRow | undefined,
  ): Promise<MarketPollContext["hlNative"]> {
    const [staking, af] = await Promise.all([
      this.fetchStaking(),
      this.fetchAf(symbol, spotCoinId, tokenIndex, capturedAt, prevSnap),
    ]);
    return { staking, af };
  }

  private async fetchStaking(): Promise<StakingMetrics | null> {
    try {
      const validators = await this.info.validatorSummaries();
      return computeStakingMetrics(validators);
    } catch (e) {
      console.warn(`[snapshot-poller] validatorSummaries failed: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * AF buy fills are windowed since the previous snapshot for this symbol
   * (or `pollIntervalMs` back on cold start, so the first snapshot has a
   * sane window instead of pulling all-time history).
   */
  private async fetchAf(
    symbol: string,
    spotCoinId: string | null,
    tokenIndex: number | null,
    capturedAt: number,
    prevSnap: SnapshotRow | undefined,
  ): Promise<AfMetrics | null> {
    const sinceMs = prevSnap?.capturedAt ?? capturedAt - this.pollIntervalMs;
    try {
      const [state, fills] = await Promise.all([
        this.info.spotClearinghouseState({ user: AF_ADDRESS }),
        this.info.userFillsByTime({ user: AF_ADDRESS, startTime: sinceMs }),
      ]);
      return computeAfMetrics(state.balances, fills, tokenIndex, spotCoinId, sinceMs);
    } catch (e) {
      console.warn(`[snapshot-poller] AF data fetch failed for ${symbol}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Compute all 10 derived signals from current context + previous snapshot. Never throws. */
  private fetchDerived(
    ctx: Omit<MarketPollContext, "derived">,
    prevSnap: SnapshotRow | undefined,
    capturedAt: number,
  ): DerivedValues {
    const prev: Record<string, number | null | undefined> = {};
    if (prevSnap) {
      for (const [key, mv] of Object.entries(prevSnap.metrics)) prev[key] = mv.value;
    }
    const intervalMs = prevSnap ? capturedAt - prevSnap.capturedAt : null;
    return computeDerived(ctx, { prev, intervalMs });
  }

  /**
   * CEX open interest + long/short ratios (point-in-time REST poll, one per
   * available venue) plus the aggregated liquidation windows accumulated by
   * each venue's CexLiqTracker since its stream connected. Unavailable
   * venues (not listed, geo-blocked, etc.) contribute null/NULL_LSR and are
   * excluded from aggregates — never throws.
   */
  private async fetchCex(
    symbol: string,
  ): Promise<{ cex: MarketPollContext["cex"]; cexLiqMeta: Record<string, { filled: number }> }> {
    const sources = this.cexSources.get(symbol);
    if (!sources) return { cex: null, cexLiqMeta: {} };

    const [binanceOi, bybitOi, okxOi, binanceLsr, bybitLsr, okxLsr] = await Promise.all([
      sources.binance.isAvailable() ? sources.binance.fetchOpenInterest() : Promise.resolve(null),
      sources.bybit.isAvailable()   ? sources.bybit.fetchOpenInterest()   : Promise.resolve(null),
      sources.okx.isAvailable()     ? sources.okx.fetchOpenInterest()     : Promise.resolve(null),
      sources.binance.isAvailable() ? sources.binance.fetchLongShortRatios() : Promise.resolve(NULL_LSR),
      sources.bybit.isAvailable()   ? sources.bybit.fetchLongShortRatios()   : Promise.resolve(NULL_LSR),
      sources.okx.isAvailable()     ? sources.okx.fetchLongShortRatios()     : Promise.resolve(NULL_LSR),
    ]);

    const total = computeOiTotal([binanceOi, bybitOi, okxOi]);
    const aggLongFrac = computeAggLongFrac([
      { accountRatio: binanceLsr.accountRatio, oi: binanceOi },
      { accountRatio: bybitLsr.accountRatio,   oi: bybitOi },
      { accountRatio: okxLsr.accountRatio,     oi: okxOi },
    ]);

    const trackers = this.cexLiqTrackers.get(symbol)!;
    const availableLiqWindows: CexLiqWindows[] = [];
    if (sources.binance.isAvailable()) availableLiqWindows.push(trackers.get("binance")!.getWindows());
    if (sources.bybit.isAvailable())   availableLiqWindows.push(trackers.get("bybit")!.getWindows());
    if (sources.okx.isAvailable())     availableLiqWindows.push(trackers.get("okx")!.getWindows());
    const liqAgg = aggregateLiqWindows(availableLiqWindows);

    const liq = liqAgg ? {
      long1h:   liqAgg.longVol1h,
      short1h:  liqAgg.shortVol1h,
      long24h:  liqAgg.longVol24h,
      short24h: liqAgg.shortVol24h,
      net24h:   liqAgg.shortVol24h - liqAgg.longVol24h,
      count24h: liqAgg.count24h,
    } : null;

    const cexLiqMeta: Record<string, { filled: number }> = {};
    if (liqAgg) {
      cexLiqMeta.cex_liq_long_1h    = { filled: liqAgg.filled1h };
      cexLiqMeta.cex_liq_short_1h   = { filled: liqAgg.filled1h };
      cexLiqMeta.cex_liq_long_24h   = { filled: liqAgg.filled24h };
      cexLiqMeta.cex_liq_short_24h  = { filled: liqAgg.filled24h };
      cexLiqMeta.cex_liq_net_24h    = { filled: liqAgg.filled24h };
      cexLiqMeta.cex_liq_count_24h  = { filled: liqAgg.filled24h };
    }

    const cex: MarketPollContext["cex"] = {
      oi: { binance: binanceOi, bybit: bybitOi, okx: okxOi, total },
      lsr: {
        binanceGlobal: binanceLsr.accountRatio,
        binanceTopPos: binanceLsr.topPositionRatio,
        binanceTaker:  binanceLsr.takerRatio,
        bybitAccount:  bybitLsr.accountRatio,
        okxAccount:    okxLsr.accountRatio,
        okxTopPos:     okxLsr.topPositionRatio,
        okxTaker:      okxLsr.takerRatio,
        aggLongFrac,
      },
      liq,
    };
    return { cex, cexLiqMeta };
  }

  /**
   * Labeled CEX wallet balances/flows + holder concentration (market-spec.md
   * §7 stage 5). With the default empty wallets: [], every balance/flow field
   * is null and walletsPolled is 0 — never throws, never zero-fakes.
   */
  private async fetchOnChain(symbol: string, perpMarkPx: string): Promise<MarketPollContext["onChain"]> {
    const reads = await Promise.all(
      this.walletsConfig.wallets
        .filter((w) => !isPlaceholderAddress(w.address))
        .map(async (w) => ({
          address: w.address,
          balance: w.layer === "hypercore"
            ? await this.balanceReader.readHypercoreBalance(w.address)
            : await this.balanceReader.readHyperevmBalance(w.address),
        })),
    );

    const { total, walletsPolled, perWallet } = aggregateBalances(reads);
    const prev = this.prevBalances.get(symbol) ?? null;
    const { netFlow, inflow, outflow } = computeFlows(perWallet, prev);
    this.prevBalances.set(symbol, perWallet);

    const markPx = safeNum(perpMarkPx);
    const netFlowUsdc = netFlow !== null && markPx !== null ? netFlow * markPx : null;

    const holders = await this.fetchHolderMetrics();

    return {
      totalBalance: total,
      walletsPolled,
      netFlow,
      inflow,
      outflow,
      netFlowUsdc,
      holders: holders ? {
        count: holders.holdersCount,
        supplyExSystem: holders.supplyExSystem,
        top10Share: holders.top10Share,
        top50Share: holders.top50Share,
        top100Share: holders.top100Share,
      } : null,
    };
  }

  /** Cached holder-distribution metrics, refreshed every HOLDER_REFRESH_MS. Returns the stale cached value (or null) on fetch failure. */
  private async fetchHolderMetrics(): Promise<HolderMetrics | null> {
    const now = Date.now();
    if (this.holderCache && now - this.holderCache.fetchedAt < HOLDER_REFRESH_MS) {
      return this.holderCache.metrics;
    }

    const dist = await this.fetchHolderDist();
    if (!dist) return this.holderCache?.metrics ?? null;

    const systemAddresses = new Set(this.walletsConfig.systemWallets.map((w) => w.address.toLowerCase()));
    const metrics = computeHolderMetrics(dist, systemAddresses);
    this.holderCache = { metrics, fetchedAt: now };
    return metrics;
  }

  /**
   * If spot_mark_px is more than SPOT_PRICE_GUARD_PCT away from perp_mark_px,
   * the resolved spot pair is suspect (e.g. an imposter token slipped through)
   * — null all spot-derived metrics rather than persist a misleading value.
   */
  private applySpotPriceGuard(symbol: string, metrics: MetricInput[]): void {
    const perpMarkPx = metrics.find((m) => m.key === "perp_mark_px")?.value ?? null;
    const spotMark   = metrics.find((m) => m.key === "spot_mark_px");
    if (perpMarkPx === null || spotMark?.value == null || perpMarkPx === 0) return;

    const ratio = Math.abs(spotMark.value - perpMarkPx) / Math.abs(perpMarkPx);
    if (ratio <= SPOT_PRICE_GUARD_PCT) return;

    console.warn(
      `[snapshot-poller] ${symbol} spot_mark_px=${spotMark.value} is >${SPOT_PRICE_GUARD_PCT * 100}% ` +
      `from perp_mark_px=${perpMarkPx} — nulling spot-derived metrics`,
    );
    for (const key of SPOT_DERIVED_METRIC_KEYS) {
      const m = metrics.find((mm) => mm.key === key);
      if (m) m.value = null;
    }
  }
}
