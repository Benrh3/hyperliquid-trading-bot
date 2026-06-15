// Metric registry — generated from docs/market/market-metrics.manifest.json.
//
// Every manifest entry becomes a MetricDefinition. Stage 1 implements compute()
// for the 9 `source: "hl-market"` / `kind: "level"` metrics (the single
// metaAndAssetCtxs + spotMetaAndAssetCtxs poll). Stage 2 adds the 8 CVD/trade-count
// metrics (trades WS aggregator) and the 7 L2 book microstructure metrics. Stage 3
// adds 7 hl-native staking + Assistance Fund metrics. Every other entry is a stub
// (compute === undefined) until its stage is built.

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
    perp: { cvd1h: number; cvd4h: number; cvd24h: number; trades24h: number } | null;
    spot: { cvd1h: number; cvd4h: number; cvd24h: number; trades24h: number } | null;
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

const COMPUTE_BY_KEY: Record<string, (ctx: MarketPollContext) => number | null> = {
  ...HL_MARKET_LEVEL_COMPUTE,
  ...CVD_COMPUTE,
  ...BOOK_COMPUTE,
  ...HL_NATIVE_COMPUTE,
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
