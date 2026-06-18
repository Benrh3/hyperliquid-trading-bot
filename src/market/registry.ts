// Metric registry — generated from docs/market/market-metrics.manifest.json.
//
// Every manifest entry becomes a MetricDefinition. Stage 1 implements compute()
// for the 9 `source: "hl-market"` / `kind: "level"` metrics (the single
// metaAndAssetCtxs + spotMetaAndAssetCtxs poll). Stage 2 adds the 8 CVD/trade-count
// metrics (trades WS aggregator) and the 7 L2 book microstructure metrics. Stage 3
// adds 7 hl-native staking + Assistance Fund metrics. Stage 4 adds 18 cex-agg
// metrics (CEX open interest, long/short ratios, CEX liquidations). Stage 5 adds
// 11 on-chain CEX-flow + holder metrics. Stage 6 adds 10 derived signals computed
// from snapshot history. Every other entry is a stub (compute === undefined) until
// its stage is built.

import { loadManifest, type ManifestMetric } from "./manifest.js";

/** Coerce a value to a finite number or null. Mirrors funding-matrix.safeNum. */
export function safeNum(v: number | string | undefined | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Minimal shape of the data available to compute() for the hl-market `level`
 * metrics — one perp asset ctx (always present for an enabled symbol) and one
 * spot asset ctx (null if the symbol has no spot market).
 */
export interface MarketPollContext {
  symbol: string;
  perpCtx: {
    markPx: string;
    oraclePx: string;
    funding: string;
    openInterest: string;
    premium: string | null;
    dayNtlVlm: string;
  };
  spotCtx: {
    markPx: string;
    dayNtlVlm: string;
  } | null;
  /** From the tokenDetails endpoint for the symbol's canonical spot token, or null. */
  circulatingSupply: string | null;
  /** From TradesAggregator — each side null if no windows are available for it. */
  cvd: {
    perp: { cvd1h: number | null; cvd4h: number | null; cvd24h: number | null; trades24h: number | null } | null;
    spot: { cvd1h: number | null; cvd4h: number | null; cvd24h: number | null; trades24h: number | null } | null;
  } | null;
  /** From a point-in-time l2Book poll — null if the book is unavailable. */
  book: {
    perp: { mid: number; spreadBps: number; bidDepth: number; askDepth: number; imbalance: number } | null;
    spot: { spreadBps: number; imbalance: number } | null;
  };
  /** From validatorSummaries + AF spotClearinghouseState/userFillsByTime — null if unavailable. */
  hlNative: {
    staking: { totalStaked: number; activeStaked: number; validatorCount: number } | null;
    af: { hypeBalance: number | null; buyHypeWindow: number; buyUsdcWindow: number; buyFills: number } | null;
  } | null;
  /** From per-venue CEX adapters (Binance/Bybit/OKX) — each field null if that venue/stat is unavailable. */
  cex: {
    oi: {
      binance: number | null;
      bybit:   number | null;
      okx:     number | null;
      total:   number | null;
    };
    lsr: {
      binanceGlobal: number | null;
      binanceTopPos: number | null;
      binanceTaker:  number | null;
      bybitAccount:  number | null;
      okxAccount:    number | null;
      okxTopPos:     number | null;
      okxTaker:      number | null;
      aggLongFrac:   number | null;
    };
    /** Aggregated across venue liquidation streams — null until at least one stream is running. */
    liq: {
      long1h:   number | null;
      short1h:  number | null;
      long24h:  number | null;
      short24h: number | null;
      net24h:   number | null;
      count24h: number | null;
    } | null;
  } | null;
  /** 10 derived signals computed from current + previous snapshot (market-spec.md §7 stage 6). Always present, fields null when inputs are unavailable/stubbed. */
  derived: {
    netTwapHype:      number | null;
    netTwapFullHype:  number | null;
    oiDelta:          number | null;
    spotPerpBasis:    number | null;
    unstakeQDelta:    number | null;
    stakedDelta:      number | null;
    afBuyRate:        number | null;
    cexBalanceDelta:  number | null;
    holderTop10Delta: number | null;
    cexOiDelta:       number | null;
  };
  /** From labeled CEX wallet balances + holder distribution (market-spec.md §7 stage 5). Null fields are the default until config/cex-wallets.json is populated. */
  onChain: {
    totalBalance:  number | null;
    walletsPolled: number;
    netFlow:       number | null;
    inflow:        number | null;
    outflow:       number | null;
    netFlowUsdc:   number | null;
    /** Null until the holder-distribution fetch has succeeded at least once. */
    holders: {
      count:          number | null;
      supplyExSystem: number | null;
      top10Share:     number | null;
      top50Share:     number | null;
      top100Share:    number | null;
    } | null;
  } | null;
}

export interface MetricDefinition extends ManifestMetric {
  /** Undefined for stages not yet built — caller should skip these entries. */
  compute?: (ctx: MarketPollContext) => number | null;
}

// ── compute() implementations for the 9 hl-market `level` metrics ──────────

const HL_MARKET_LEVEL_COMPUTE: Record<string, (ctx: MarketPollContext) => number | null> = {
  perp_mark_px:       (ctx) => safeNum(ctx.perpCtx.markPx),
  perp_oracle_px:     (ctx) => safeNum(ctx.perpCtx.oraclePx),
  funding_rate:       (ctx) => safeNum(ctx.perpCtx.funding),
  open_interest:      (ctx) => safeNum(ctx.perpCtx.openInterest),
  perp_premium:       (ctx) => safeNum(ctx.perpCtx.premium),
  perp_day_ntl_vlm:   (ctx) => safeNum(ctx.perpCtx.dayNtlVlm),
  spot_mark_px:       (ctx) => (ctx.spotCtx ? safeNum(ctx.spotCtx.markPx) : null),
  spot_day_ntl_vlm:   (ctx) => (ctx.spotCtx ? safeNum(ctx.spotCtx.dayNtlVlm) : null),
  circulating_supply: (ctx) => safeNum(ctx.circulatingSupply),
};

// ── compute() implementations for the 8 hl-market CVD/trade-count metrics ──

const CVD_COMPUTE: Record<string, (ctx: MarketPollContext) => number | null> = {
  cvd_perp_1h:          (ctx) => ctx.cvd?.perp?.cvd1h ?? null,
  cvd_perp_4h:          (ctx) => ctx.cvd?.perp?.cvd4h ?? null,
  cvd_perp_24h:         (ctx) => ctx.cvd?.perp?.cvd24h ?? null,
  cvd_spot_1h:          (ctx) => ctx.cvd?.spot?.cvd1h ?? null,
  cvd_spot_4h:          (ctx) => ctx.cvd?.spot?.cvd4h ?? null,
  cvd_spot_24h:         (ctx) => ctx.cvd?.spot?.cvd24h ?? null,
  cvd_perp_trades_24h:  (ctx) => ctx.cvd?.perp?.trades24h ?? null,
  cvd_spot_trades_24h:  (ctx) => ctx.cvd?.spot?.trades24h ?? null,
};

// ── compute() implementations for the 7 hl-native L2 book metrics ──────────

const BOOK_COMPUTE: Record<string, (ctx: MarketPollContext) => number | null> = {
  book_mid:             (ctx) => ctx.book.perp?.mid ?? null,
  book_spread_bps:      (ctx) => ctx.book.perp?.spreadBps ?? null,
  book_bid_depth:       (ctx) => ctx.book.perp?.bidDepth ?? null,
  book_ask_depth:       (ctx) => ctx.book.perp?.askDepth ?? null,
  book_imbalance:       (ctx) => ctx.book.perp?.imbalance ?? null,
  book_spot_spread_bps: (ctx) => ctx.book.spot?.spreadBps ?? null,
  book_spot_imbalance:  (ctx) => ctx.book.spot?.imbalance ?? null,
};

// ── compute() implementations for the 7 hl-native staking + AF metrics ─────

const HL_NATIVE_COMPUTE: Record<string, (ctx: MarketPollContext) => number | null> = {
  total_staked_hype:  (ctx) => ctx.hlNative?.staking?.totalStaked ?? null,
  active_staked_hype: (ctx) => ctx.hlNative?.staking?.activeStaked ?? null,
  validator_count:    (ctx) => ctx.hlNative?.staking?.validatorCount ?? null,
  af_hype_balance:    (ctx) => ctx.hlNative?.af?.hypeBalance ?? null,
  af_buy_hype_window: (ctx) => ctx.hlNative?.af?.buyHypeWindow ?? null,
  af_buy_usdc_window: (ctx) => ctx.hlNative?.af?.buyUsdcWindow ?? null,
  af_buy_fills:       (ctx) => ctx.hlNative?.af?.buyFills ?? null,
};

// ── compute() implementations for the 18 cex-agg metrics ───────────────────

const CEX_COMPUTE: Record<string, (ctx: MarketPollContext) => number | null> = {
  cex_oi_binance_hype: (ctx) => ctx.cex?.oi.binance ?? null,
  cex_oi_bybit_hype:   (ctx) => ctx.cex?.oi.bybit ?? null,
  cex_oi_okx_hype:     (ctx) => ctx.cex?.oi.okx ?? null,
  cex_oi_total_hype:   (ctx) => ctx.cex?.oi.total ?? null,

  lsr_binance_global:  (ctx) => ctx.cex?.lsr.binanceGlobal ?? null,
  lsr_binance_top_pos: (ctx) => ctx.cex?.lsr.binanceTopPos ?? null,
  lsr_binance_taker:   (ctx) => ctx.cex?.lsr.binanceTaker ?? null,
  lsr_bybit_account:   (ctx) => ctx.cex?.lsr.bybitAccount ?? null,
  lsr_okx_account:     (ctx) => ctx.cex?.lsr.okxAccount ?? null,
  lsr_okx_top_pos:     (ctx) => ctx.cex?.lsr.okxTopPos ?? null,
  lsr_okx_taker:       (ctx) => ctx.cex?.lsr.okxTaker ?? null,
  lsr_agg_long_frac:   (ctx) => ctx.cex?.lsr.aggLongFrac ?? null,

  cex_liq_long_1h:    (ctx) => ctx.cex?.liq?.long1h ?? null,
  cex_liq_short_1h:   (ctx) => ctx.cex?.liq?.short1h ?? null,
  cex_liq_long_24h:   (ctx) => ctx.cex?.liq?.long24h ?? null,
  cex_liq_short_24h:  (ctx) => ctx.cex?.liq?.short24h ?? null,
  cex_liq_net_24h:    (ctx) => ctx.cex?.liq?.net24h ?? null,
  cex_liq_count_24h:  (ctx) => ctx.cex?.liq?.count24h ?? null,
};

// ── compute() implementations for the 10 derived signals (stage 6) ──────────

const DERIVED_COMPUTE: Record<string, (ctx: MarketPollContext) => number | null> = {
  net_twap_hype:      (ctx) => ctx.derived.netTwapHype,
  net_twap_full_hype: (ctx) => ctx.derived.netTwapFullHype,
  oi_delta:           (ctx) => ctx.derived.oiDelta,
  spot_perp_basis:    (ctx) => ctx.derived.spotPerpBasis,
  unstake_q_delta:    (ctx) => ctx.derived.unstakeQDelta,
  staked_delta:       (ctx) => ctx.derived.stakedDelta,
  af_buy_rate:        (ctx) => ctx.derived.afBuyRate,
  cex_balance_delta:  (ctx) => ctx.derived.cexBalanceDelta,
  holder_top10_delta: (ctx) => ctx.derived.holderTop10Delta,
  cex_oi_delta:       (ctx) => ctx.derived.cexOiDelta,
};

// ── compute() implementations for the 11 on-chain CEX-flow + holder metrics ─

const ON_CHAIN_COMPUTE: Record<string, (ctx: MarketPollContext) => number | null> = {
  cex_inflow_hype:       (ctx) => ctx.onChain?.inflow ?? null,
  cex_outflow_hype:      (ctx) => ctx.onChain?.outflow ?? null,
  cex_net_flow_hype:     (ctx) => ctx.onChain?.netFlow ?? null,
  cex_net_flow_usdc:     (ctx) => ctx.onChain?.netFlowUsdc ?? null,
  cex_total_balance_hype: (ctx) => ctx.onChain?.totalBalance ?? null,
  cex_wallets_polled:    (ctx) => ctx.onChain?.walletsPolled ?? null,

  holders_count:          (ctx) => ctx.onChain?.holders?.count ?? null,
  holder_supply_ex_system: (ctx) => ctx.onChain?.holders?.supplyExSystem ?? null,
  holder_top10_share:     (ctx) => ctx.onChain?.holders?.top10Share ?? null,
  holder_top50_share:     (ctx) => ctx.onChain?.holders?.top50Share ?? null,
  holder_top100_share:    (ctx) => ctx.onChain?.holders?.top100Share ?? null,
};

const COMPUTE_BY_KEY: Record<string, (ctx: MarketPollContext) => number | null> = {
  ...HL_MARKET_LEVEL_COMPUTE,
  ...CVD_COMPUTE,
  ...BOOK_COMPUTE,
  ...HL_NATIVE_COMPUTE,
  ...CEX_COMPUTE,
  ...ON_CHAIN_COMPUTE,
  ...DERIVED_COMPUTE,
};

let cached: MetricDefinition[] | null = null;

/** Build the full metric registry from the manifest. Cached after first call. */
export function buildRegistry(): MetricDefinition[] {
  if (cached) return cached;
  const manifest = loadManifest();
  cached = manifest.metrics.map((entry) => ({
    ...entry,
    compute: COMPUTE_BY_KEY[entry.key],
  }));
  return cached;
}

/** Metric definitions that have a compute() implementation for this stage. */
export function getImplementedMetrics(): MetricDefinition[] {
  return buildRegistry().filter((m) => m.compute !== undefined);
}

/** Whether a metric applies to the given symbol per its `appliesTo` field. */
export function metricAppliesTo(metric: ManifestMetric, symbol: string): boolean {
  if (metric.appliesTo === "all") return true;
  if (metric.appliesTo === "hype-only") return symbol === "HYPE";
  return false;
}
