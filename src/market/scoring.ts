// Scoring engine for market signals — Spearman IC, hit rate, bias, scorecard.
//
// market-spec.md §3: IC = Spearman rank correlation between signal value and
// forward return. Scored only when n ≥ MIN_N past the horizon. Bias = weighted
// vote of IC-proven signals per holding horizon.

import { loadManifest } from "./manifest.js";
import type { MarketStore } from "./store.js";

export const SCORING_HORIZONS_H = [4, 24, 72, 168] as const;
export type HorizonH = (typeof SCORING_HORIZONS_H)[number];

/** Minimum paired samples for a cell to leave "warming" state and show IC/hit_rate. */
export const MIN_N = 8;

// ── Pure math helpers ─────────────────────────────────────────────────────────

/** Average-rank ties per Spearman standard. Input sorted ascending by caller. */
function rankValues(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
    const avgRank = (i + j + 1) / 2; // 1-based average
    for (let k = i; k < j; k++) ranks[indexed[k].i] = avgRank;
    i = j;
  }
  return ranks;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  const denom = Math.sqrt(vx * vy);
  return denom === 0 ? 0 : cov / denom;
}

/**
 * Spearman rank correlation of paired (signal, return) values.
 * Returns NaN for fewer than 2 finite pairs.
 */
export function spearmanIC(pairs: ReadonlyArray<[number, number]>): number {
  const finite = pairs.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (finite.length < 2) return NaN;
  const xs = finite.map(([x]) => x);
  const ys = finite.map(([, y]) => y);
  return pearson(rankValues(xs), rankValues(ys));
}

/**
 * Hit rate: fraction of pairs where sign(signal) === sign(return).
 * Pairs where either is zero are excluded (ambiguous direction).
 */
export function hitRate(pairs: ReadonlyArray<[number, number]>): number {
  const directed = pairs.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x !== 0 && y !== 0);
  if (directed.length === 0) return NaN;
  const hits = directed.filter(([x, y]) => Math.sign(x) === Math.sign(y)).length;
  return hits / directed.length;
}

// ── Forward-return computation ────────────────────────────────────────────────

/**
 * Given the per-mark-px price time series (ascending by capturedAt), binary-
 * search for the first price at or after targetMs. Returns null if none exists
 * or if the candidate price is itself null.
 */
export function lookupForwardPrice(
  priceTimeSeries: ReadonlyArray<{ capturedAt: number; value: number | null }>,
  targetMs: number,
): number | null {
  let lo = 0, hi = priceTimeSeries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (priceTimeSeries[mid].capturedAt < targetMs) lo = mid + 1;
    else hi = mid - 1;
  }
  if (lo >= priceTimeSeries.length) return null;
  return priceTimeSeries[lo].value ?? null;
}

/** Minimum ms between accepted entry points — one per hour prevents minute-cadence
 *  snapshots from inflating n and creating overlapping forward-return windows. */
const ENTRY_DECIMATION_MS = 3_600_000;

/**
 * Build (signal, forwardReturn) pairs for a single signal × horizon cell.
 * No-lookahead: excludes any snapshot where capturedAt + horizonMs > nowMs.
 * Entry-decimated: at most one pair per hour (signalSeries is ascending).
 */
export function buildPairs(
  signalSeries:  ReadonlyArray<{ capturedAt: number; value: number | null }>,
  priceSeries:   ReadonlyArray<{ capturedAt: number; value: number | null }>,
  horizonMs:     number,
  nowMs:         number,
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let lastAcceptedTs = -Infinity;
  for (const { capturedAt, value } of signalSeries) {
    if (value === null || !Number.isFinite(value)) continue;
    if (capturedAt - lastAcceptedTs < ENTRY_DECIMATION_MS) continue;
    if (capturedAt + horizonMs > nowMs) continue;
    const currentPx = lookupForwardPrice(priceSeries, capturedAt);
    const futurePx  = lookupForwardPrice(priceSeries, capturedAt + horizonMs);
    if (currentPx === null || currentPx === 0 || futurePx === null) continue;
    const fwdReturn = (futurePx - currentPx) / currentPx;
    if (!Number.isFinite(fwdReturn)) continue;
    pairs.push([value, fwdReturn]);
    lastAcceptedTs = capturedAt;
  }
  return pairs;
}

// ── Scorecard ─────────────────────────────────────────────────────────────────

export interface ScoreCell {
  signal:    string;
  horizon_h: number;
  n:         number;
  ic:        number | null;
  hit_rate:  number | null;
}

/**
 * Compute the full scorecard (39 signalForScoring signals × 4 horizons = 156
 * cells) from the store's accumulated snapshot history.
 */
export function buildScorecard(
  store:    MarketStore,
  symbol:   string,
  nowMs:    number = Date.now(),
): ScoreCell[] {
  const manifest = loadManifest();
  const signals  = manifest.metrics.filter((m) => m.signalForScoring);

  const priceSeries = store.getMetricTimeSeries(symbol, "perp_mark_px");
  const cells: ScoreCell[] = [];

  for (const sig of signals) {
    const sigSeries = store.getMetricTimeSeries(symbol, sig.key);
    for (const h of SCORING_HORIZONS_H) {
      const horizonMs = h * 3_600_000;
      const pairs     = buildPairs(sigSeries, priceSeries, horizonMs, nowMs);
      const n         = pairs.length;
      if (n < MIN_N) {
        cells.push({ signal: sig.key, horizon_h: h, n, ic: null, hit_rate: null });
      } else {
        const ic       = spearmanIC(pairs);
        const hr       = hitRate(pairs);
        cells.push({
          signal:    sig.key,
          horizon_h: h,
          n,
          ic:       Number.isFinite(ic) ? ic : null,
          hit_rate: Number.isFinite(hr) ? hr : null,
        });
      }
    }
  }
  return cells;
}

// ── Bias aggregation ──────────────────────────────────────────────────────────

export interface BiasResult {
  horizon_h:  number;
  label:      "Bullish" | "Bearish" | "Neutral";
  score:      number;
  bullCount:  number;
  bearCount:  number;
  confidence: "HIGH" | "LOW";
}

export interface CategoryBias {
  category: string;
  label:    "Bullish" | "Bearish" | "Neutral";
  score:    number;
}

export interface BiasResponse {
  horizon_h:      number;
  label:          "Bullish" | "Bearish" | "Neutral";
  score:          number;
  bullCount:      number;
  bearCount:      number;
  confidence:     "HIGH" | "LOW";
  categoryBiases: CategoryBias[];
}

/** Minimum number of IC-scored signals required for HIGH confidence. */
const MIN_SCORED_FOR_HIGH_CONFIDENCE = 5;

/**
 * Mean |IC| across scored signals must exceed this before confidence flips to HIGH.
 * Prevents early-data noise from inflating confidence: with only days of history,
 * Spearman IC values cluster near zero by chance even if scoredCount is large.
 */
const IC_THRESHOLD_FOR_HIGH_CONFIDENCE = 0.10;

/**
 * Weighted bias vote for a given horizon. Weight = |IC| for scored cells,
 * 0 for warming. Direction = sign(current_value) × sign(IC) — handles
 * contrarian signals naturally (negative IC on a positive signal = bearish vote).
 */
export function computeBias(
  cells:         ReadonlyArray<ScoreCell>,
  currentValues: Record<string, number | null>,
  horizonH:      number,
  symbol:        string,
): BiasResponse {
  const manifest = loadManifest();
  const signals  = manifest.metrics.filter((m) => m.signalForScoring);

  let rawSum     = 0;
  let totalWeight = 0;
  let bullCount  = 0;
  let bearCount  = 0;
  let scoredCount = 0;
  let sumAbsIC   = 0;

  // Per-category accumulators
  const catRaw    = new Map<string, number>();
  const catWeight = new Map<string, number>();

  for (const sig of signals) {
    const cell = cells.find((c) => c.signal === sig.key && c.horizon_h === horizonH);
    if (!cell || cell.ic === null) continue; // warming — skip
    scoredCount++;
    sumAbsIC += Math.abs(cell.ic);

    const currentVal = currentValues[sig.key];
    if (currentVal === null || currentVal === undefined || !Number.isFinite(currentVal)) continue;

    const direction = Math.sign(currentVal); // +1 | -1 | 0
    if (direction === 0) continue;

    const weight = Math.abs(cell.ic);
    const vote   = direction * cell.ic; // +ve = bullish, -ve = bearish

    rawSum      += vote * weight;
    totalWeight += weight;

    const cat = sig.subtab ?? "other";
    catRaw.set(cat, (catRaw.get(cat) ?? 0) + vote * weight);
    catWeight.set(cat, (catWeight.get(cat) ?? 0) + weight);

    if (vote > 0) bullCount++;
    else if (vote < 0) bearCount++;
  }

  const score     = totalWeight > 0 ? rawSum / totalWeight : 0;
  const meanAbsIC = scoredCount > 0 ? sumAbsIC / scoredCount : 0;
  const confidence: BiasResult["confidence"] =
    scoredCount >= MIN_SCORED_FOR_HIGH_CONFIDENCE && meanAbsIC >= IC_THRESHOLD_FOR_HIGH_CONFIDENCE
      ? "HIGH"
      : "LOW";
  // Suppress Bullish/Bearish labels until IC is proven — early noise reads as Neutral.
  const label: BiasResult["label"] = confidence === "LOW"
    ? "Neutral"
    : score > 0.05 ? "Bullish" : score < -0.05 ? "Bearish" : "Neutral";

  const categoryBiases: CategoryBias[] = [];
  for (const [cat, w] of catWeight) {
    const s = w > 0 ? (catRaw.get(cat) ?? 0) / w : 0;
    categoryBiases.push({
      category: cat,
      label: confidence === "LOW" ? "Neutral" : s > 0.05 ? "Bullish" : s < -0.05 ? "Bearish" : "Neutral",
      score: s,
    });
  }

  return { horizon_h: horizonH, label, score, bullCount, bearCount, confidence, categoryBiases };
}

// ── CSV export helpers ────────────────────────────────────────────────────────

/** Render scorecard as CSV matching scorecard.sample.csv shape. */
export function scorecardToCsv(cells: ReadonlyArray<ScoreCell>): string {
  const lines = ["signal,horizon_h,n,ic,hit_rate"];
  for (const c of cells) {
    const ic  = c.ic       !== null ? c.ic.toFixed(3)       : "";
    const hr  = c.hit_rate !== null ? c.hit_rate.toFixed(3) : "";
    lines.push(`${c.signal},${c.horizon_h},${c.n},${ic},${hr}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Render snapshots.csv matching snapshots.sample.csv shape.
 * Columns: ts_ms + every raw (derived=false) metric key in manifest order.
 * Only uses raw snapshot_metrics rows; derived signals are not included.
 */
export function buildSnapshotsCsv(store: MarketStore, symbol: string): string {
  const manifest   = loadManifest();
  const rawKeys    = manifest.metrics.filter((m) => !m.derived).map((m) => m.key);
  const timestamps = store.getSnapshotTimestamps(symbol);

  const header = ["ts_ms", ...rawKeys].join(",");
  const rows: string[] = [header];

  for (const ts of timestamps) {
    const metrics = store.getSnapshotMetrics(symbol, ts);
    const cols = [String(ts), ...rawKeys.map((k) => {
      const v = metrics[k];
      return v === undefined || v === null ? "" : String(v);
    })];
    rows.push(cols.join(","));
  }
  return rows.join("\n") + "\n";
}
