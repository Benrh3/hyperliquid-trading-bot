import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { config } from "./config.js";
import type { Logger } from "./logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const DYDX_INDEXER = "https://indexer.v4testnet.dydx.exchange/v4";
const POLL_INTERVAL_MS = 45_000;
const FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_TOP_N    = 25;

// ── Public types ──────────────────────────────────────────────────────────────

export interface MatrixEntry {
  coin:    string;
  oiUsd:   number;
  rates: {
    hyperliquid: number | null;
    dydx:        number | null;
  };
  /** Absolute spread (hr rate) — null when either venue rate is missing. */
  spread:   number | null;
  /** Which pair maximises collected funding — null when either rate is missing. */
  bestPair: "hyperliquid_short_dydx_long" | "dydx_short_hyperliquid_long" | null;
}

export interface FundingMatrix {
  updatedAt: string;   // ISO timestamp of last successful poll
  stale:     boolean;  // true when last poll failed; data is from prior cycle
  venues:    string[];
  coins:     MatrixEntry[];
}

// ── Internal raw-data types used by the pure builder ─────────────────────────

export interface VenueCoinData {
  rateHourly:       number;
  markPriceUsd:     number;
  openInterestUsd:  number;
}

// ── Pure builder — testable without network ───────────────────────────────────

/**
 * Given raw per-venue maps, build the ranked MatrixEntry array.
 *
 * Coins not listed on a venue appear with null rates in that venue's cell.
 * OI ranking uses the maximum OI reported by any venue.
 * spread and bestPair are null whenever either venue lacks a rate.
 * NaN is never returned: any non-finite number is coerced to null.
 */
export function buildMatrixEntries(
  hlCoins:   Map<string, VenueCoinData>,
  dydxCoins: Map<string, VenueCoinData>,
  topN:      number,
): MatrixEntry[] {
  // 1. Collect the full universe from both venues
  const allCoins = new Set<string>([...hlCoins.keys(), ...dydxCoins.keys()]);

  // 2. Compute combined OI for ranking (max across venues)
  const ranked = [...allCoins]
    .map((coin) => {
      const hlOi   = safeNum(hlCoins.get(coin)?.openInterestUsd)   ?? 0;
      const dydxOi = safeNum(dydxCoins.get(coin)?.openInterestUsd) ?? 0;
      return { coin, oiUsd: Math.max(hlOi, dydxOi) };
    })
    .sort((a, b) => b.oiUsd - a.oiUsd)
    .slice(0, topN);

  // 3. Build entries for the top-N coins
  return ranked.map(({ coin, oiUsd }) => {
    const hlRate   = safeNum(hlCoins.get(coin)?.rateHourly);
    const dydxRate = safeNum(dydxCoins.get(coin)?.rateHourly);

    const spread    = computeSpread(hlRate, dydxRate);
    const bestPair  = computeBestPair(hlRate, dydxRate);

    return { coin, oiUsd, rates: { hyperliquid: hlRate, dydx: dydxRate }, spread, bestPair };
  });
}

export function computeSpread(
  hlRate:   number | null,
  dydxRate: number | null,
): number | null {
  if (hlRate === null || dydxRate === null) return null;
  const s = Math.abs(hlRate - dydxRate);
  return Number.isFinite(s) ? s : null;
}

export function computeBestPair(
  hlRate:   number | null,
  dydxRate: number | null,
): MatrixEntry["bestPair"] {
  if (hlRate === null || dydxRate === null) return null;
  return hlRate >= dydxRate
    ? "hyperliquid_short_dydx_long"
    : "dydx_short_hyperliquid_long";
}

/** Coerce a value to a finite number or null. Prevents NaN leaking into API. */
export function safeNum(v: number | string | undefined | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

// ── Poller class ──────────────────────────────────────────────────────────────

export class FundingMatrixPoller {
  private readonly info:   InfoClient;
  private readonly logger: Logger | undefined;
  private readonly topN:   number;

  private cache: FundingMatrix = {
    updatedAt: new Date(0).toISOString(),
    stale:     true,
    venues:    ["hyperliquid", "dydx"],
    coins:     [],
  };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(logger?: Logger, topN = DEFAULT_TOP_N) {
    const isTestnet = config.exchange.network === "testnet";
    this.info   = new InfoClient({ transport: new HttpTransport({ isTestnet }) });
    this.logger = logger;
    this.topN   = topN;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.poll(); // initial fill before the timer fires
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    console.log(`[funding-matrix] Poller started (${this.topN} coins, ${POLL_INTERVAL_MS / 1000}s interval)`);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getMatrix(): FundingMatrix { return this.cache; }

  // ── Poll cycle ──────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    let hlCoins:   Map<string, VenueCoinData> = new Map();
    let dydxCoins: Map<string, VenueCoinData> = new Map();
    let anyFailed = false;

    // Fetch both venues concurrently; failures are isolated
    const [hlResult, dydxResult] = await Promise.allSettled([
      this.fetchHl(),
      this.fetchDydx(),
    ]);

    if (hlResult.status === "fulfilled") {
      hlCoins = hlResult.value;
    } else {
      anyFailed = true;
      console.warn(`[funding-matrix] HL fetch failed: ${(hlResult.reason as Error).message}`);
    }

    if (dydxResult.status === "fulfilled") {
      dydxCoins = dydxResult.value;
    } else {
      anyFailed = true;
      console.warn(`[funding-matrix] dYdX fetch failed: ${(dydxResult.reason as Error).message}`);
    }

    // If BOTH venues failed, keep the last-good cache marked stale
    if (hlCoins.size === 0 && dydxCoins.size === 0) {
      this.cache = { ...this.cache, stale: true };
      return;
    }

    const coins = buildMatrixEntries(hlCoins, dydxCoins, this.topN);

    this.cache = {
      updatedAt: new Date().toISOString(),
      stale:     anyFailed,  // partial failure → stale flag but data still updates
      venues:    ["hyperliquid", "dydx"],
      coins,
    };

    // Persist funding samples — fire-and-forget
    if (this.logger) {
      const ts = Date.now();
      const samples: Array<{ coin: string; venue: string; rateHourly: number }> = [];
      for (const [coin, d] of hlCoins)   samples.push({ coin, venue: "hyperliquid", rateHourly: d.rateHourly });
      for (const [coin, d] of dydxCoins) samples.push({ coin, venue: "dydx",        rateHourly: d.rateHourly });
      void Promise.resolve().then(() => this.logger!.writeFundingSamples(ts, samples));
    }
  }

  // ── Venue fetchers ──────────────────────────────────────────────────────────

  private async fetchHl(): Promise<Map<string, VenueCoinData>> {
    const [meta, ctxs] = await this.info.metaAndAssetCtxs();
    const out = new Map<string, VenueCoinData>();

    for (let i = 0; i < meta.universe.length; i++) {
      const coin = meta.universe[i].name;
      const ctx  = ctxs[i];
      if (!ctx) continue;

      const rate   = safeNum(ctx.funding);
      const mark   = safeNum(ctx.midPx ?? ctx.markPx ?? null);
      const oiBase = safeNum(ctx.openInterest);

      if (rate === null || mark === null || oiBase === null) continue;

      out.set(coin, {
        rateHourly:      rate,
        markPriceUsd:    mark,
        openInterestUsd: oiBase * mark,
      });
    }
    return out;
  }

  private async fetchDydx(): Promise<Map<string, VenueCoinData>> {
    const resp = await fetch(`${DYDX_INDEXER}/perpetualMarkets`, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`dYdX HTTP ${resp.status}`);

    type MktEntry = {
      status?:         string;
      nextFundingRate?: string;
      oraclePrice?:    string;
      indexPrice?:     string;
      openInterest?:   string;
    };
    const data = await resp.json() as { markets?: Record<string, MktEntry> };
    const out  = new Map<string, VenueCoinData>();

    for (const [ticker, mkt] of Object.entries(data.markets ?? {})) {
      if (mkt.status !== "ACTIVE") continue;

      // Convert "BTC-USD" → "BTC"
      const coin = ticker.replace(/-USD$/, "");

      const rate   = safeNum(mkt.nextFundingRate);
      const price  = safeNum(mkt.oraclePrice ?? mkt.indexPrice);
      const oiBase = safeNum(mkt.openInterest);

      if (rate === null || price === null || oiBase === null) continue;

      out.set(coin, {
        rateHourly:      rate,
        markPriceUsd:    price,
        openInterestUsd: oiBase * price,
      });
    }
    return out;
  }
}
