import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { config } from "./config.js";
import type { Logger } from "./logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS     = 45_000;
const FETCH_TIMEOUT_MS     = 12_000;
const DEFAULT_TOP_N        = 25;

// dYdX retry-with-backoff (5xx responses only — not timeouts or client errors)
const DYDX_MAX_RETRIES     = 3;             // up to 3 retries → max delay 1+2+4 = 7s
const DYDX_BACKOFF_BASE_MS = 1_000;

// Gap audit run once at startup: warn on consecutive timestamps > 5 min apart.
// 5 min ≈ 7 missed poll cycles — filters normal poll jitter (< 1 missed cycle expected).
const GAP_AUDIT_WINDOW_MS  = 7 * 24 * 3_600_000; // match raw-row retention (7 days)
const GAP_THRESHOLD_MS     = 5 * 60_000;          // 5 minutes

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Maximum magnitude for annualised funding display (±300 %/yr).
 * Thin-market coins occasionally produce nonsensical values like -97 950 %/yr;
 * winsorising at this cap keeps the heatmap colour scale readable.
 */
export const ANN_RATE_CAP_PCT = 300; // %/yr

// ── Network configuration for funding data (read-only, never execution) ───────

/**
 * FUNDING_DATA_NETWORK controls which public indexers the funding-matrix poller
 * reads from.  It is intentionally separate from config.exchange.network so that
 * funding data can be sourced from mainnet (meaningful rates, real OI) while all
 * order execution stays on testnet.
 *
 * Set FUNDING_DATA_NETWORK=mainnet in .env to read from:
 *   HL   → https://api.hyperliquid.xyz/info  (public, no auth)
 *   dYdX → https://indexer.dydx.trade/v4     (public, no auth)
 *
 * Default is "mainnet" because testnet indexers return zero rates (no premium).
 *
 * This function is exported so it can be unit-tested independently.
 */
export function getFundingDataNetwork(): "mainnet" | "testnet" {
  const raw = process.env.FUNDING_DATA_NETWORK?.trim().toLowerCase();
  if (raw === "testnet") return "testnet";
  return "mainnet"; // default: mainnet data even when trading on testnet
}

/** URL pair for a given data network — purely a mapping, no side effects. */
export function getFundingDataUrls(network: "mainnet" | "testnet"): {
  hlIsTestnet: boolean;
  dydxIndexer: string;
} {
  if (network === "testnet") {
    return {
      hlIsTestnet: true,
      dydxIndexer: "https://indexer.v4testnet.dydx.exchange/v4",
    };
  }
  return {
    hlIsTestnet: false,
    dydxIndexer: "https://indexer.dydx.trade/v4",
  };
}

/**
 * Clamp an annualised rate (as a fraction, e.g. 0.001 = 0.1%/hr → ~8.76%/yr)
 * to ±ANN_RATE_CAP_PCT percent/year so junk values don't distort the display.
 * Returns null for null input.
 */
export function clampAnnRate(rateHourly: number | null): number | null {
  if (rateHourly === null) return null;
  const HOURS_PER_YEAR = 8_760;
  const annPct = rateHourly * HOURS_PER_YEAR * 100;
  if (!Number.isFinite(annPct)) return null;
  const clamped = Math.max(-ANN_RATE_CAP_PCT, Math.min(ANN_RATE_CAP_PCT, annPct));
  // Convert back to hourly fraction so callers can format consistently
  return clamped / (HOURS_PER_YEAR * 100);
}

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
  updatedAt:   string;              // ISO timestamp of last successful poll
  stale:       boolean;             // true when last poll failed; data is from prior cycle
  venues:      string[];
  coins:       MatrixEntry[];
  dataNetwork: "mainnet" | "testnet"; // which public indexers supplied this data
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

  // 3. Build entries for the top-N coins.
  //    Rates are winsorised via clampAnnRate so display is always within ±ANN_RATE_CAP_PCT.
  return ranked.map(({ coin, oiUsd }) => {
    const hlRate   = clampAnnRate(safeNum(hlCoins.get(coin)?.rateHourly));
    const dydxRate = clampAnnRate(safeNum(dydxCoins.get(coin)?.rateHourly));

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
  private readonly info:        InfoClient;
  private readonly logger:      Logger | undefined;
  private readonly topN:        number;
  private readonly dydxIndexer: string;
  private readonly dataNetwork: "mainnet" | "testnet";

  private cache: FundingMatrix = {
    updatedAt:   new Date(0).toISOString(),
    stale:       true,
    venues:      ["hyperliquid", "dydx"],
    coins:       [],
    dataNetwork: "mainnet",
  };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(logger?: Logger, topN = DEFAULT_TOP_N) {
    // ── Data network is SEPARATE from trading network ─────────────────────────
    // FUNDING_DATA_NETWORK controls which public indexers we READ from.
    // config.exchange.network controls which chain we TRADE on.
    // These must never be conflated: the poller is read-only and never calls
    // openPosition / closePosition / checkTradingReady.
    this.dataNetwork  = getFundingDataNetwork();
    const { hlIsTestnet, dydxIndexer } = getFundingDataUrls(this.dataNetwork);

    this.info        = new InfoClient({ transport: new HttpTransport({ isTestnet: hlIsTestnet }) });
    this.dydxIndexer = dydxIndexer;
    this.logger      = logger;
    this.topN        = topN;

    console.log(
      `[funding-matrix] Data network: ${this.dataNetwork} ` +
      `(HL: ${hlIsTestnet ? "testnet" : "mainnet"}, dYdX: ${this.dydxIndexer})`,
    );
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.poll(); // initial fill before the timer fires
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    console.log(`[funding-matrix] Poller started (${this.topN} coins, ${POLL_INTERVAL_MS / 1000}s interval)`);
    this.runStartupGapAudit();
  }

  private runStartupGapAudit(): void {
    if (!this.logger) return;
    try {
      const since = Date.now() - GAP_AUDIT_WINDOW_MS;
      const gaps  = this.logger.getSpreadHistoryGaps(since, GAP_THRESHOLD_MS);
      if (gaps.length === 0) {
        console.log(`[funding-matrix] Gap audit: ✓ no gaps > ${GAP_THRESHOLD_MS / 60_000}min in spread history (last 7d)`);
        return;
      }
      const totalMins = gaps.reduce((s, g) => s + g.gapMs, 0) / 60_000;
      console.warn(
        `[funding-matrix] Gap audit: ${gaps.length} gap(s) > ${GAP_THRESHOLD_MS / 60_000}min found ` +
        `in last 7d  (~${totalMins.toFixed(0)}min total missing)`,
      );
      for (const g of gaps) {
        console.warn(
          `  ${new Date(g.from).toISOString().slice(0, 16)} → ` +
          `${new Date(g.to).toISOString().slice(0, 16)}  ` +
          `(${(g.gapMs / 60_000).toFixed(1)}min)`,
        );
      }
    } catch (e) {
      console.warn(`[funding-matrix] Gap audit failed: ${(e as Error).message}`);
    }
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
      updatedAt:   new Date().toISOString(),
      stale:       anyFailed,  // partial failure → stale flag but data still updates
      venues:      ["hyperliquid", "dydx"],
      coins,
      dataNetwork: this.dataNetwork,
    };

    // Persist funding samples for matrix coins only (not the full universe)
    if (this.logger) {
      const ts = Date.now();
      const matrixCoins = new Set(coins.map((c) => c.coin));
      const samples: Array<{ coin: string; venue: string; rateHourly: number }> = [];
      for (const [coin, d] of hlCoins)   { if (matrixCoins.has(coin)) samples.push({ coin, venue: "hyperliquid", rateHourly: d.rateHourly }); }
      for (const [coin, d] of dydxCoins) { if (matrixCoins.has(coin)) samples.push({ coin, venue: "dydx",        rateHourly: d.rateHourly }); }
      void Promise.resolve().then(() => this.logger!.writeFundingSamples(ts, samples));

      // Persist per-coin spread history for long-run analysis
      const spreadRows = coins.map((e) => ({
        coin:        e.coin,
        hlFunding:   e.rates.hyperliquid,
        dydxFunding: e.rates.dydx,
        spreadAbs:   e.spread,
        spreadDir:   e.bestPair === "hyperliquid_short_dydx_long" ? "hl>dydx"
                   : e.bestPair === "dydx_short_hyperliquid_long" ? "dydx>hl"
                   : null,
        hlOiUsd:     e.oiUsd,
      }));
      void Promise.resolve().then(() => this.logger!.writeSpreadHistory(ts, spreadRows));
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
    type MktEntry = {
      status?:          string;
      nextFundingRate?: string;
      oraclePrice?:     string;
      indexPrice?:      string;
      openInterest?:    string;
    };

    for (let attempt = 0; ; attempt++) {
      const resp = await fetch(`${this.dydxIndexer}/perpetualMarkets`, {
        headers: { Accept: "application/json" },
        signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!resp.ok) {
        if (resp.status >= 500 && attempt < DYDX_MAX_RETRIES) {
          const delayMs = DYDX_BACKOFF_BASE_MS * Math.pow(2, attempt);
          console.warn(
            `[funding-matrix] dYdX HTTP ${resp.status} — ` +
            `retry ${attempt + 1}/${DYDX_MAX_RETRIES} in ${delayMs}ms`,
          );
          await sleep(delayMs);
          continue;
        }
        throw new Error(`dYdX HTTP ${resp.status}`);
      }

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
}
