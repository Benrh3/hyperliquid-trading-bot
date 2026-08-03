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
 * Semantics mirror backtest attachSignals(): returns the most recent value
 * whose capturedAt ≤ cutoffMs (the bar's close time).  Uses a single
 * UNION ALL query over both the raw (snapshot_metrics) and rolled-up
 * (snapshot_metrics_hourly) tables — identical to getMetricTimeSeries's
 * data sources, but returns only the MAX row instead of the full series.
 *
 * Staleness guard: if (cutoffMs − capturedAt) > staleThresholdMs, the value
 * is replaced with NaN.  Both FundingExtremeStrategy and
 * CrowdPositioningStrategy already guard  `isNaN(rawVal)` → return null,
 * so a stale signal causes a silent abstain with no code changes to strategies.
 */
export class LiveSignalProvider {
  private stmt: Database.Statement;

  constructor(
    private db: Database.Database,
    readonly staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
  ) {
    this.stmt = db.prepare(`
      SELECT t.capturedAt, t.value
      FROM (
        SELECT sm.captured_at AS capturedAt, sm.value
          FROM snapshot_metrics sm
          JOIN snapshots s ON s.id = sm.snapshot_id
         WHERE s.symbol = ? AND sm.metric_key = ? AND sm.captured_at <= ?
        UNION ALL
        SELECT ts_hour AS capturedAt, avg_value AS value
          FROM snapshot_metrics_hourly
         WHERE symbol = ? AND metric_key = ? AND ts_hour <= ?
      ) t
      ORDER BY t.capturedAt DESC
      LIMIT 1
    `);
  }

  /**
   * @param symbol    e.g. "HYPE"
   * @param key       metric key, e.g. "funding_rate"
   * @param cutoffMs  bar close time (epoch ms) — signals after this are excluded
   */
  get(symbol: string, key: string, cutoffMs: number): LiveSignalResult {
    const row = this.stmt.get(symbol, key, cutoffMs, symbol, key, cutoffMs) as
      { capturedAt: number; value: number | null } | undefined;

    if (!row) {
      return { value: NaN, capturedAt: null, stale: true };
    }

    const stale = (cutoffMs - row.capturedAt) > this.staleThresholdMs;
    return {
      value:      stale ? NaN : row.value,
      capturedAt: row.capturedAt,
      stale,
    };
  }
}
