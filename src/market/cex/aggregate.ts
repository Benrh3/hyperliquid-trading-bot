// Cross-venue aggregation helpers for cex-agg (market-spec.md §7 stage 4).
// Pure functions — no I/O — so they're independently unit-testable.

import type { CexLiqWindows } from "./liqTracker.js";

/** cex_oi_total_hype — sum of whichever per-venue OI readings are available. Null if none are. */
export function computeOiTotal(ois: (number | null)[]): number | null {
  const available = ois.filter((v): v is number => v !== null);
  if (available.length === 0) return null;
  return available.reduce((a, b) => a + b, 0);
}

export interface VenueAccountRatio {
  /** Account-level long/short ratio (>1 = more long accounts), or null if unsupported. */
  accountRatio: number | null;
  /** This venue's open interest (same units as other venues' weights). */
  oi: number | null;
}

/**
 * lsr_agg_long_frac — OI-weighted cross-venue long fraction. For each venue
 * with both an account ratio `r` and OI, `longFrac = r / (1 + r)`; the
 * aggregate is the OI-weighted average of those fractions. Null if no venue
 * has both values.
 */
export function computeAggLongFrac(venues: VenueAccountRatio[]): number | null {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const v of venues) {
    if (v.accountRatio === null || v.oi === null || v.oi <= 0 || !Number.isFinite(v.accountRatio)) continue;
    const longFrac = v.accountRatio / (1 + v.accountRatio);
    weightedSum += longFrac * v.oi;
    totalWeight += v.oi;
  }
  if (totalWeight === 0) return null;
  return weightedSum / totalWeight;
}

export interface AggregatedLiqWindows {
  longVol1h:   number;
  shortVol1h:  number;
  longVol24h:  number;
  shortVol24h: number;
  count24h:    number;
  /** Min filled fraction across contributing venues — conservative coverage estimate. */
  filled1h:    number;
  filled24h:   number;
}

/** Sum per-venue liquidation windows. Null if no venue streams are running. */
export function aggregateLiqWindows(windows: CexLiqWindows[]): AggregatedLiqWindows | null {
  if (windows.length === 0) return null;
  const out: AggregatedLiqWindows = {
    longVol1h: 0, shortVol1h: 0, longVol24h: 0, shortVol24h: 0, count24h: 0,
    filled1h: 1, filled24h: 1,
  };
  for (const w of windows) {
    out.longVol1h   += w.longVol1h;
    out.shortVol1h  += w.shortVol1h;
    out.longVol24h  += w.longVol24h;
    out.shortVol24h += w.shortVol24h;
    out.count24h    += w.count24h;
    out.filled1h     = Math.min(out.filled1h, w.filled1h);
    out.filled24h    = Math.min(out.filled24h, w.filled24h);
  }
  return out;
}
