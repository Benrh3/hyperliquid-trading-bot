import Database from "better-sqlite3";

const HOUR_MS = 3_600_000;
export const DEFAULT_STALE_THRESHOLD_MS = 2 * HOUR_MS;

export interface LiveSignalResult {
  /** NaN when stale or no data; null when the DB row holds an explicit null. */
  value:      number | null;
  capturedAt: number | null;
  stale:      boolean;
}

/**
 * Point-in-time lookup of a single Market signal metric for a given symbol.
 *
 * Returns the **trailing 1-hour mean** of raw snapshot_metrics samples whose
 * capturedAt falls in (cutoffMs − HOUR_MS, cutoffMs].  This mirrors what the
 * corrected hourly rollup provides via getMetricTimeSeries: a bucket-end
 * timestamp so that the averaged value is never assigned to a candle that
 * closed before the bucket finished collecting.
 *
 * Falls back to the most recent hourly rollup row when no raw samples exist
 * in the trailing window (e.g. on cold-start or after a long poller outage).
 * The fallback uses ts_hour + HOUR_MS as capturedAt, matching the reader-side
 * fix in getMetricTimeSeries.
 *
 * Staleness guard: if (cutoffMs − MAX(capturedAt)) > staleThresholdMs the
 * value is NaN.  Strategies already guard isNaN(rawVal) → return null.
 */
export class LiveSignalProvider {
  private stmtRawMean:         Database.Statement;
  private stmtHourlyFallback:  Database.Statement;

  constructor(
    private db: Database.Database,
    readonly staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
  ) {
    // AVG of raw samples in the 1-hour window ending at cutoffMs.
    // MAX(captured_at) drives the staleness check; COUNT guards the empty-result case.
    this.stmtRawMean = db.prepare(`
      SELECT AVG(sm.value) AS value,
             MAX(sm.captured_at) AS capturedAt,
             COUNT(*) AS cnt
      FROM snapshot_metrics sm
      JOIN snapshots s ON s.id = sm.snapshot_id
      WHERE s.symbol    = ?
        AND sm.metric_key = ?
        AND sm.captured_at > ? - ${HOUR_MS}
        AND sm.captured_at <= ?
    `);

    // Hourly fallback with the same ts_hour + HOUR_MS offset as getMetricTimeSeries,
    // so the capturedAt reported here has the same lookahead-free semantics.
    this.stmtHourlyFallback = db.prepare(`
      SELECT ts_hour + ${HOUR_MS} AS capturedAt, avg_value AS value
      FROM snapshot_metrics_hourly
      WHERE symbol     = ?
        AND metric_key = ?
        AND ts_hour + ${HOUR_MS} <= ?
      ORDER BY ts_hour DESC
      LIMIT 1
    `);
  }

  /**
   * @param symbol    e.g. "HYPE"
   * @param key       metric key, e.g. "funding_rate"
   * @param cutoffMs  bar close time (epoch ms) — samples after this are excluded
   */
  get(symbol: string, key: string, cutoffMs: number): LiveSignalResult {
    const raw = this.stmtRawMean.get(symbol, key, cutoffMs, cutoffMs) as
      { value: number | null; capturedAt: number | null; cnt: number } | undefined;

    if (raw && raw.cnt > 0 && raw.capturedAt !== null) {
      const stale = (cutoffMs - raw.capturedAt) > this.staleThresholdMs;
      return {
        value:      stale ? NaN : raw.value,
        capturedAt: raw.capturedAt,
        stale,
      };
    }

    // No raw samples in the trailing window — try the hourly rollup.
    const hourly = this.stmtHourlyFallback.get(symbol, key, cutoffMs) as
      { capturedAt: number; value: number | null } | undefined;

    if (!hourly) {
      return { value: NaN, capturedAt: null, stale: true };
    }

    const stale = (cutoffMs - hourly.capturedAt) > this.staleThresholdMs;
    return {
      value:      stale ? NaN : hourly.value,
      capturedAt: hourly.capturedAt,
      stale,
    };
  }
}
