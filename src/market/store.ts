// Store for the Market data subsystem — tall/EAV snapshots + snapshot_metrics
// (see migrations/003_market_snapshots.sql and market-spec.md §1).
//
// WAL mode lets this store share data/bot.db with the main bot process and
// the dashboard without locking, even though the snapshot-poller runs as its
// own PM2 process (market-spec.md §0: isolated failure domain).

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

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

    for (const name of ["003_market_snapshots.sql", "004_fix_imposter_spot_pair.sql"]) {
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
   * Roll up snapshot_metrics rows older than `retentionRawDays` into hourly
   * buckets, then delete the raw rows. Mirrors Logger.runRetentionPolicy.
   */
  runRetentionPolicy(retentionRawDays = DEFAULT_RETENTION_RAW_DAYS): void {
    const cutoff = Date.now() - retentionRawDays * 24 * HOUR_MS;
    try {
      this.db.transaction(() => {
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
        `).run(cutoff);

        this.db.prepare(`
          DELETE FROM snapshot_metrics WHERE snapshot_id IN (
            SELECT id FROM snapshots WHERE captured_at < ?
          )
        `).run(cutoff);
        this.db.prepare("DELETE FROM snapshots WHERE captured_at < ?").run(cutoff);
      })();
    } catch (e) {
      console.warn("[market-store] Retention policy failed:", (e as Error).message);
    }
  }

  close(): void {
    this.db.close();
  }
}
