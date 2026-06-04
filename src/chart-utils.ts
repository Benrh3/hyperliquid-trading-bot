/**
 * chart-utils.ts — pure, side-effect-free helpers used by the overview charts.
 * Keeping these in TypeScript makes them fully testable without a browser.
 */

// ── P&L aggregation ───────────────────────────────────────────────────────────

export interface BotPnlEntry {
  realizedPnl:   number;
  unrealizedPnl: number;
  totalPnl:      number;
  tradeCount:    number;
}

export interface PnlTotals {
  realizedPnl:   number;
  unrealizedPnl: number;
  totalPnl:      number;
  tradeCount:    number;
}

/** Sum per-bot P&L entries into portfolio totals. Guards against non-finite inputs. */
export function aggregatePnl(bots: BotPnlEntry[]): PnlTotals {
  return bots.reduce<PnlTotals>(
    (acc, b) => ({
      realizedPnl:   acc.realizedPnl   + (Number.isFinite(b.realizedPnl)   ? b.realizedPnl   : 0),
      unrealizedPnl: acc.unrealizedPnl + (Number.isFinite(b.unrealizedPnl) ? b.unrealizedPnl : 0),
      totalPnl:      acc.totalPnl      + (Number.isFinite(b.totalPnl)       ? b.totalPnl       : 0),
      tradeCount:    acc.tradeCount    + (Number.isInteger(b.tradeCount)    ? b.tradeCount    : 0),
    }),
    { realizedPnl: 0, unrealizedPnl: 0, totalPnl: 0, tradeCount: 0 },
  );
}

// ── Time-series range selection ───────────────────────────────────────────────

export interface TimedRow { ts: number }

/**
 * Filter a time-series to rows within the last `rangeMs` milliseconds.
 * Rows must have a `ts` field in epoch-milliseconds.
 * Returns a new array; does not mutate the input.
 */
export function selectRange<T extends TimedRow>(rows: T[], rangeMs: number): T[] {
  if (!Number.isFinite(rangeMs) || rangeMs <= 0) return [];
  const cutoff = Date.now() - rangeMs;
  return rows.filter((r) => r.ts >= cutoff);
}

// ── Uniform downsampling ──────────────────────────────────────────────────────

/**
 * Reduce a time-series to at most `maxPoints` evenly-spaced samples.
 * The first and last points are always preserved.
 * Returns a new array; does not mutate the input.
 */
export function downsample<T extends TimedRow>(rows: T[], maxPoints: number): T[] {
  if (rows.length === 0 || maxPoints < 1) return [];
  if (rows.length <= maxPoints)           return rows.slice();

  const out: T[] = [];
  // step: how many source rows each output slot spans
  const step = (rows.length - 1) / (maxPoints - 1);

  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(Math.round(i * step), rows.length - 1);
    out.push(rows[idx]);
  }

  // Guarantee last point is exact (floating-point rounding guard)
  out[out.length - 1] = rows[rows.length - 1];
  return out;
}

// ── Spread alignment ──────────────────────────────────────────────────────────

export interface FundingRow extends TimedRow {
  venue:       string;
  rate_hourly: number;
}

export interface SpreadRow extends TimedRow {
  hl:     number | null;
  dydx:   number | null;
  spread: number | null;
}

/**
 * Join HL and dYdX funding rows by matching timestamps (within 1 s tolerance)
 * and compute per-timestamp spread. Used for the funding history chart.
 */
export function alignFundingRows(rows: FundingRow[]): SpreadRow[] {
  const hlMap   = new Map<number, number>();
  const dydxMap = new Map<number, number>();

  for (const r of rows) {
    if (!Number.isFinite(r.rate_hourly)) continue;
    // Round to nearest 10 s bucket for fuzzy join
    const bucket = Math.round(r.ts / 10_000) * 10_000;
    if (r.venue === "hyperliquid") hlMap.set(bucket, r.rate_hourly);
    else if (r.venue === "dydx")   dydxMap.set(bucket, r.rate_hourly);
  }

  const allBuckets = new Set([...hlMap.keys(), ...dydxMap.keys()]);
  const result: SpreadRow[] = [];

  for (const bucket of allBuckets) {
    const hl   = hlMap.get(bucket)   ?? null;
    const dydx = dydxMap.get(bucket) ?? null;
    const spread = (hl !== null && dydx !== null)
      ? Math.abs(hl - dydx)
      : null;
    result.push({ ts: bucket, hl, dydx, spread });
  }

  return result.sort((a, b) => a.ts - b.ts);
}
