// Store for the Market data subsystem — tall/EAV snapshots + snapshot_metrics
// (see migrations/003_market_snapshots.sql and market-spec.md §1).
//
// WAL mode lets this store share data/bot.db with the main bot process and
// the dashboard without locking, even though the snapshot-poller runs as its
// own PM2 process (market-spec.md §0: isolated failure domain).

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import type { HorizonName, Call, Regime, SwingCurrentStateRow, SwingFlipRow } from "../swing-advisor/types.js";

const HOUR_MS = 3_600_000;
const DEFAULT_RETENTION_RAW_DAYS = 7;

export interface MetricInput {
  key:    string;
  value:  number | null;
  source: string;
  kind:   string;
  meta?:  unknown;
}

export interface SnapshotMetricValue {
  value:      number | null;
  source:     string;
  kind:       string;
  meta:       unknown;
  capturedAt: number;
}

export interface SnapshotRow {
  id:         number;
  symbol:     string;
  network:    string;
  capturedAt: number;
  metrics:    Record<string, SnapshotMetricValue>;
}

export class MarketStore {
  private db: Database.Database;
  private stmtInsertSnapshot:    Database.Statement;
  private stmtInsertMetric:      Database.Statement;

  constructor(dbPath = "data/bot.db") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    for (const name of ["003_market_snapshots.sql", "004_fix_imposter_spot_pair.sql", "007_cvd_buckets.sql", "011_liq_tracker_buckets.sql", "014_swing_advisor.sql"]) {
      const migration = join(process.cwd(), "migrations", name);
      if (existsSync(migration)) this.db.exec(readFileSync(migration, "utf-8"));
    }

    this.stmtInsertSnapshot = this.db.prepare(
      "INSERT INTO snapshots (symbol, network, captured_at) VALUES (?, ?, ?)",
    );
    this.stmtInsertMetric = this.db.prepare(`
      INSERT INTO snapshot_metrics (snapshot_id, metric_key, value, source, kind, meta_json, captured_at)
      VALUES (@snapshotId, @key, @value, @source, @kind, @meta, @capturedAt)
    `);
  }

  /** Insert one snapshot row plus its metric rows in a single transaction. Returns the snapshot id. */
  writeSnapshot(symbol: string, network: string, capturedAt: number, metrics: MetricInput[]): number {
    const tx = this.db.transaction(() => {
      const { lastInsertRowid } = this.stmtInsertSnapshot.run(symbol, network, capturedAt);
      const snapshotId = Number(lastInsertRowid);
      for (const m of metrics) {
        this.stmtInsertMetric.run({
          snapshotId,
          key:        m.key,
          value:      m.value,
          source:     m.source,
          kind:       m.kind,
          meta:       m.meta !== undefined ? JSON.stringify(m.meta) : null,
          capturedAt,
        });
      }
      return snapshotId;
    });
    return tx();
  }

  /** Most recent `limit` snapshots for a symbol, newest first, each with its metric map. */
  getRecentSnapshots(symbol: string, limit = 50): SnapshotRow[] {
    const snapshots = this.db
      .prepare("SELECT id, symbol, network, captured_at FROM snapshots WHERE symbol = ? ORDER BY captured_at DESC LIMIT ?")
      .all(symbol, limit) as { id: number; symbol: string; network: string; captured_at: number }[];

    if (snapshots.length === 0) return [];

    const ids = snapshots.map((s) => s.id);
    const placeholders = ids.map(() => "?").join(",");
    const metricRows = this.db
      .prepare(`SELECT snapshot_id, metric_key, value, source, kind, meta_json, captured_at FROM snapshot_metrics WHERE snapshot_id IN (${placeholders})`)
      .all(...ids) as { snapshot_id: number; metric_key: string; value: number | null; source: string; kind: string; meta_json: string | null; captured_at: number }[];

    const metricsBySnapshot = new Map<number, Record<string, SnapshotMetricValue>>();
    for (const row of metricRows) {
      let bucket = metricsBySnapshot.get(row.snapshot_id);
      if (!bucket) { bucket = {}; metricsBySnapshot.set(row.snapshot_id, bucket); }
      bucket[row.metric_key] = {
        value:      row.value,
        source:     row.source,
        kind:       row.kind,
        meta:       row.meta_json ? JSON.parse(row.meta_json) : null,
        capturedAt: row.captured_at,
      };
    }

    return snapshots.map((s) => ({
      id:         s.id,
      symbol:     s.symbol,
      network:    s.network,
      capturedAt: s.captured_at,
      metrics:    metricsBySnapshot.get(s.id) ?? {},
    }));
  }

  /**
   * Roll up snapshot_metrics into hourly buckets, then prune old raw rows.
   *
   * Rollup processes all completed hours (decoupled from the prune cutoff)
   * so snapshot_metrics_hourly stays current. INSERT OR IGNORE makes
   * re-processing idempotent. Deletes are batched to avoid long-held locks.
   */
  runRetentionPolicy(retentionRawDays = DEFAULT_RETENTION_RAW_DAYS): void {
    const hourFloor   = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const pruneCutoff = Date.now() - retentionRawDays * 24 * HOUR_MS;
    const BATCH       = 50_000;

    // Roll up all completed hours into hourly table
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO snapshot_metrics_hourly (ts_hour, symbol, metric_key, avg_value, source, kind, sample_count)
        SELECT (sm.captured_at / ${HOUR_MS}) * ${HOUR_MS},
               s.symbol,
               sm.metric_key,
               AVG(sm.value),
               sm.source,
               sm.kind,
               COUNT(*)
        FROM snapshot_metrics sm
        JOIN snapshots s ON s.id = sm.snapshot_id
        WHERE sm.captured_at < ?
        GROUP BY (sm.captured_at / ${HOUR_MS}), s.symbol, sm.metric_key
      `).run(hourFloor);
    } catch (e) {
      console.warn("[market-store] Rollup failed:", (e as Error).message);
    }

    // Prune raw rows older than retention window
    try {
      let total = 0;
      const stmt = this.db.prepare(
        `DELETE FROM snapshot_metrics WHERE rowid IN (
          SELECT sm.rowid FROM snapshot_metrics sm
          JOIN snapshots s ON s.id = sm.snapshot_id
          WHERE s.captured_at < ? LIMIT ?
        )`,
      );
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = stmt.run(pruneCutoff, BATCH);
        total += result.changes;
        if (result.changes < BATCH) break;
      }
      this.db.prepare("DELETE FROM snapshots WHERE captured_at < ?").run(pruneCutoff);
      if (total > 0) console.log(`[market-store] Retention: pruned ${total} snapshot_metrics rows`);
    } catch (e) {
      console.warn("[market-store] Prune failed:", (e as Error).message);
    }
  }

  /**
   * Full time series of a single metric for a symbol — both raw (snapshot_metrics)
   * and rolled-up hourly (snapshot_metrics_hourly) rows, oldest first. Nulls preserved.
   * Used by the scoring engine and the snapshots.csv export.
   */
  getMetricTimeSeries(symbol: string, key: string): Array<{ capturedAt: number; value: number | null }> {
    const raw = this.db.prepare(`
      SELECT sm.captured_at AS capturedAt, sm.value
      FROM snapshot_metrics sm
      JOIN snapshots s ON s.id = sm.snapshot_id
      WHERE s.symbol = ? AND sm.metric_key = ?
      ORDER BY sm.captured_at ASC
    `).all(symbol, key) as { capturedAt: number; value: number | null }[];

    const hourly = this.db.prepare(`
      SELECT ts_hour AS capturedAt, avg_value AS value
      FROM snapshot_metrics_hourly
      WHERE symbol = ? AND metric_key = ?
        AND ts_hour < (SELECT COALESCE(MIN(sm.captured_at), 9999999999999) FROM snapshot_metrics sm JOIN snapshots s ON s.id = sm.snapshot_id WHERE s.symbol = ? AND sm.metric_key = ?)
      ORDER BY ts_hour ASC
    `).all(symbol, key, symbol, key) as { capturedAt: number; value: number | null }[];

    return [...hourly, ...raw];
  }

  /**
   * Snapshot key-list for building the snapshots.csv export: all distinct capturedAt
   * values for a symbol, oldest first.
   */
  getSnapshotTimestamps(symbol: string): number[] {
    return (this.db.prepare(
      "SELECT captured_at FROM snapshots WHERE symbol = ? ORDER BY captured_at ASC",
    ).all(symbol) as { captured_at: number }[]).map((r) => r.captured_at);
  }

  /**
   * Get all metric values for a single snapshot (by capturedAt) — used for
   * CSV row assembly.
   */
  getSnapshotMetrics(symbol: string, capturedAt: number): Record<string, number | null> {
    const rows = this.db.prepare(`
      SELECT sm.metric_key, sm.value
      FROM snapshot_metrics sm
      JOIN snapshots s ON s.id = sm.snapshot_id
      WHERE s.symbol = ? AND s.captured_at = ?
    `).all(symbol, capturedAt) as { metric_key: string; value: number | null }[];
    const out: Record<string, number | null> = {};
    for (const r of rows) out[r.metric_key] = r.value;
    return out;
  }

  // ── CVD tracker persistence ─────────────────────────────────────────────────

  saveCvdTracker(trackerId: string, bootTime: number, bucketsJson: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO cvd_tracker_state (tracker_id, boot_time, buckets_json, updated_at) VALUES (?, ?, ?, ?)",
    ).run(trackerId, bootTime, bucketsJson, Date.now());
  }

  loadCvdTracker(trackerId: string): { bootTime: number; bucketsJson: string } | null {
    const row = this.db.prepare(
      "SELECT boot_time, buckets_json FROM cvd_tracker_state WHERE tracker_id = ?",
    ).get(trackerId) as { boot_time: number; buckets_json: string } | undefined;
    if (!row) return null;
    return { bootTime: row.boot_time, bucketsJson: row.buckets_json };
  }

  // ── CEX liquidation tracker persistence ─────────────────────────────────────

  saveLiqTracker(trackerId: string, bootTime: number, bucketsJson: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO liq_tracker_state (tracker_id, boot_time, buckets_json, updated_at) VALUES (?, ?, ?, ?)",
    ).run(trackerId, bootTime, bucketsJson, Date.now());
  }

  loadLiqTracker(trackerId: string): { bootTime: number; bucketsJson: string } | null {
    const row = this.db.prepare(
      "SELECT boot_time, buckets_json FROM liq_tracker_state WHERE tracker_id = ?",
    ).get(trackerId) as { boot_time: number; buckets_json: string } | undefined;
    if (!row) return null;
    return { bootTime: row.boot_time, bucketsJson: row.buckets_json };
  }

  /**
   * Signal health for the overview tile.
   * - latestSnapshotAgeMs: ms since the most-recent snapshot was captured (null = never polled).
   * - warmSignalCount: distinct metric keys with a non-null value in that single latest
   *   snapshot — i.e. the last completed poll cycle, not a rolling window.
   */
  getSignalHealth(symbol = "HYPE"): {
    latestSnapshotAgeMs: number | null;
    warmSignalCount: number;
  } {
    const latest = this.db.prepare(
      "SELECT MAX(captured_at) AS ts FROM snapshots WHERE symbol = ?",
    ).get(symbol) as { ts: number | null } | undefined;
    const ts = latest?.ts ?? null;
    const latestSnapshotAgeMs = ts !== null ? Date.now() - ts : null;

    let warmSignalCount = 0;
    if (ts !== null) {
      const warm = this.db.prepare(`
        SELECT COUNT(DISTINCT sm.metric_key) AS cnt
        FROM snapshot_metrics sm
        JOIN snapshots s ON s.id = sm.snapshot_id
        WHERE s.symbol = ? AND s.captured_at = ? AND sm.value IS NOT NULL
      `).get(symbol, ts) as { cnt: number } | undefined;
      warmSignalCount = warm?.cnt ?? 0;
    }

    return { latestSnapshotAgeMs, warmSignalCount };
  }

  // ── Swing advisor persistence ────────────────────────────────────────────────

  getSwingCurrentState(horizon: HorizonName): SwingCurrentStateRow | null {
    const row = this.db.prepare(
      "SELECT * FROM swing_current_state WHERE horizon = ?",
    ).get(horizon) as SwingCurrentStateRow | undefined;
    return row ?? null;
  }

  getAllSwingCurrentStates(): SwingCurrentStateRow[] {
    return this.db.prepare("SELECT * FROM swing_current_state").all() as SwingCurrentStateRow[];
  }

  upsertSwingCurrentState(row: SwingCurrentStateRow): void {
    this.db.prepare(`
      INSERT INTO swing_current_state
        (horizon, call, updated_at, last_computed_at, regime, composite_score, agreement_score, voices_json, last_notified_at)
      VALUES
        (@horizon, @call, @updated_at, @last_computed_at, @regime, @composite_score, @agreement_score, @voices_json, @last_notified_at)
      ON CONFLICT(horizon) DO UPDATE SET
        call             = excluded.call,
        updated_at       = excluded.updated_at,
        last_computed_at = excluded.last_computed_at,
        regime           = excluded.regime,
        composite_score  = excluded.composite_score,
        agreement_score  = excluded.agreement_score,
        voices_json      = excluded.voices_json,
        last_notified_at = COALESCE(excluded.last_notified_at, swing_current_state.last_notified_at)
    `).run(row);
  }

  updateSwingLastNotified(horizon: HorizonName, ts: number): void {
    this.db.prepare(
      "UPDATE swing_current_state SET last_notified_at = ? WHERE horizon = ?",
    ).run(ts, horizon);
  }

  insertSwingFlip(row: Omit<SwingFlipRow, "id">): number {
    const result = this.db.prepare(`
      INSERT INTO swing_flip_log
        (created_at, horizon, old_call, new_call, hype_price, regime, agreement_score, composite_score, voices_json, forward_return, fill_after_at)
      VALUES
        (@created_at, @horizon, @old_call, @new_call, @hype_price, @regime, @agreement_score, @composite_score, @voices_json, @forward_return, @fill_after_at)
    `).run(row);
    return Number(result.lastInsertRowid);
  }

  getSwingFlipLog(limit = 50): SwingFlipRow[] {
    return this.db.prepare(
      "SELECT * FROM swing_flip_log ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as SwingFlipRow[];
  }

  getUnfilledFlips(now: number): SwingFlipRow[] {
    return this.db.prepare(
      "SELECT * FROM swing_flip_log WHERE forward_return IS NULL AND fill_after_at <= ? AND hype_price IS NOT NULL",
    ).all(now) as SwingFlipRow[];
  }

  fillFlipForwardReturn(id: number, forwardReturn: number): void {
    this.db.prepare(
      "UPDATE swing_flip_log SET forward_return = ? WHERE id = ?",
    ).run(forwardReturn, id);
  }

  close(): void {
    this.db.close();
  }
}
