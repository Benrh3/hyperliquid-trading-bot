import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { bus } from "./events.js";
import { config } from "./config.js";
import type { Signal, TradeResult } from "./events.js";

interface TradeRow {
  id: number;
  order_id: string;
  coin: string;
  side: "long" | "short";
  size: number;
  price: number;
  pnl: number | null;
  strategy: string;
  reason: string | null;
  success: number;
  error: string | null;
  created_at: string;
}

interface EventRow {
  id: number;
  module: string;
  level: "info" | "warn" | "error";
  message: string;
  data: string | null;
  created_at: string;
}

interface DailyPnlRow {
  id: number;
  date: string;
  starting_balance: number;
  ending_balance: number;
  pnl: number;
  trade_count: number;
}

// 7 days in milliseconds — raw rows older than this are rolled up
const RETENTION_RAW_MS = 7 * 24 * 60 * 60_000;
const HOUR_MS          = 3_600_000;

export interface EquityHistoryRow { ts: number; equity_usd: number }
export interface FundingSampleRow { ts: number; coin: string; venue: string; rate_hourly: number }
export interface FundingSampleHourlyRow { ts_hour: number; coin: string; venue: string; avg_rate_hourly: number; sample_count: number }

export class Logger {
  private db: Database.Database;
  private stmtInsertTrade:    Database.Statement;
  private stmtInsertEvent:    Database.Statement;
  private stmtInsertEquity:   Database.Statement;
  private stmtInsertFunding:  Database.Statement;
  private stmtInsertSpread:   Database.Statement;

  constructor(dbPath = "data/bot.db") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    // Load all migrations in order
    for (const file of ["001_init.sql", "002_funding_matrix.sql", "006_funding_spread_history.sql"]) {
      const p = join(process.cwd(), "migrations", file);
      if (existsSync(p)) this.db.exec(readFileSync(p, "utf-8"));
    }

    this.stmtInsertTrade = this.db.prepare(`
      INSERT INTO trades (order_id, coin, side, size, price, pnl, strategy, success, error)
      VALUES (@orderId, @coin, @side, @size, @price, @pnl, @strategy, @success, @error)
    `);

    this.stmtInsertEvent = this.db.prepare(`
      INSERT INTO events (module, level, message, data)
      VALUES (@module, @level, @message, @data)
    `);

    this.stmtInsertEquity = this.db.prepare(
      "INSERT OR REPLACE INTO equity_history (ts, equity_usd) VALUES (?, ?)",
    );
    this.stmtInsertFunding = this.db.prepare(
      "INSERT OR REPLACE INTO funding_samples (ts, coin, venue, rate_hourly) VALUES (?, ?, ?, ?)",
    );
    this.stmtInsertSpread = this.db.prepare(
      "INSERT OR REPLACE INTO funding_spread_history (ts, coin, hl_funding, dydx_funding, spread_abs, spread_dir, hl_oi_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );

    this.wire();
    console.log(`[logger] SQLite ready — ${dbPath}`);
  }

  private wire(): void {
    bus.on("trade", (result: TradeResult) => {
      this.stmtInsertTrade.run({
        orderId: result.orderId,
        coin: result.coin,
        side: result.side,
        size: result.size,
        price: result.price,
        pnl: result.pnl ?? null,
        strategy: result.strategy ?? config.strategy.type,
        success: result.success ? 1 : 0,
        error: result.error ?? null,
      });
    });

    bus.on("error", (module: string, error: Error) => {
      this.stmtInsertEvent.run({
        module,
        level: "error",
        message: error.message,
        data: error.stack ?? null,
      });
    });

    bus.on("signal", (signal: Signal) => {
      this.stmtInsertEvent.run({
        module: "strategy",
        level: "info",
        message: `Signal ${signal.side} ${signal.coin}: ${signal.reason}`,
        data: JSON.stringify(signal),
      });
    });

    bus.on("signal:approved", (signal: Signal) => {
      this.stmtInsertEvent.run({
        module: "risk",
        level: "info",
        message: `Approved ${signal.side} ${signal.coin}`,
        data: JSON.stringify(signal),
      });
    });

    bus.on("signal:rejected", (signal: Signal, reason: string) => {
      this.stmtInsertEvent.run({
        module: "risk",
        level: "warn",
        message: `Rejected ${signal.side} ${signal.coin}: ${reason}`,
        data: JSON.stringify(signal),
      });
    });
  }

  getRecentTrades(limit = 20): TradeRow[] {
    return this.db
      .prepare("SELECT * FROM trades ORDER BY created_at DESC LIMIT ?")
      .all(limit) as TradeRow[];
  }

  getTrades(limit = 100, offset = 0): TradeRow[] {
    return this.db
      .prepare("SELECT * FROM trades ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as TradeRow[];
  }

  getTradeCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM trades")
      .get() as { count: number };
    return row.count;
  }

  getSumPnl(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE pnl IS NOT NULL AND success = 1")
      .get() as { total: number };
    return row.total;
  }

  /**
   * Reconstruct realised trade count and P&L for a bot from the durable trade log.
   * Keyed by strategy+coin (the fields currently stored on each trade row).
   * NOTE: two bots with the same strategy+coin would collide — if that's ever
   * needed, add a bot_id column to the trades table.
   */
  getBotRealisedStats(strategy: string, coin: string): { tradeCount: number; realisedPnl: number } {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt, COALESCE(SUM(pnl), 0) as pnl FROM trades WHERE strategy = ? AND coin = ? AND success = 1",
    ).get(strategy, coin) as { cnt: number; pnl: number };
    return { tradeCount: row.cnt, realisedPnl: row.pnl };
  }

  getDailyPnl(): DailyPnlRow[] {
    return this.db
      .prepare("SELECT * FROM daily_pnl ORDER BY date DESC")
      .all() as DailyPnlRow[];
  }

  getEventLog(limit = 50): EventRow[] {
    return this.db
      .prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as EventRow[];
  }

  /**
   * Write a structured event row directly — used by modules that don't go
   * through the bus (e.g. the cross-venue strategy's flip events).
   */
  logEvent(
    module:  string,
    level:   "info" | "warn" | "error",
    message: string,
    data?:   unknown,
  ): void {
    this.stmtInsertEvent.run({
      module,
      level,
      message,
      data: data != null ? JSON.stringify(data) : null,
    });
  }

  // ── Time-series writes (fire-and-forget safe) ───────────────────────────────

  /** Snapshot current total equity. Call with `void` to avoid blocking. */
  snapshotEquity(equityUsd: number): void {
    const v = isFinite(equityUsd) ? equityUsd : 0;
    try { this.stmtInsertEquity.run(Date.now(), v); }
    catch { /* non-critical */ }
  }

  /** Persist one poll cycle of funding samples. Call with `void`. */
  writeFundingSamples(
    ts:      number,
    samples: Array<{ coin: string; venue: string; rateHourly: number }>,
  ): void {
    const insert = this.stmtInsertFunding;
    try {
      const tx = this.db.transaction(() => {
        for (const s of samples) {
          const rate = isFinite(s.rateHourly) ? s.rateHourly : 0;
          insert.run(ts, s.coin, s.venue, rate);
        }
      });
      tx();
    } catch { /* non-critical */ }
  }

  writeSpreadHistory(
    ts:      number,
    entries: Array<{ coin: string; hlFunding: number | null; dydxFunding: number | null; spreadAbs: number | null; spreadDir: string | null; hlOiUsd: number }>,
  ): void {
    const insert = this.stmtInsertSpread;
    try {
      const tx = this.db.transaction(() => {
        for (const e of entries) {
          insert.run(
            ts, e.coin,
            e.hlFunding !== null && isFinite(e.hlFunding) ? e.hlFunding : null,
            e.dydxFunding !== null && isFinite(e.dydxFunding) ? e.dydxFunding : null,
            e.spreadAbs !== null && isFinite(e.spreadAbs) ? e.spreadAbs : null,
            e.spreadDir,
            isFinite(e.hlOiUsd) ? e.hlOiUsd : null,
          );
        }
      });
      tx();
    } catch { /* non-critical */ }
  }

  // ── Time-series queries ──────────────────────────────────────────────────────

  /**
   * Return equity history for the last `rangeMs` milliseconds.
   * Combines raw rows (≤7 days) and hourly rollups (>7 days) so any range works.
   */
  getEquityHistory(rangeMs: number): EquityHistoryRow[] {
    const cutoff = Date.now() - rangeMs;
    const raw = this.db
      .prepare("SELECT ts, equity_usd FROM equity_history WHERE ts >= ? ORDER BY ts")
      .all(cutoff) as EquityHistoryRow[];
    // If the range extends beyond 7 days, also pull from hourly rollup
    if (rangeMs > RETENTION_RAW_MS) {
      const rollup = this.db
        .prepare(
          "SELECT ts_hour AS ts, avg_equity_usd AS equity_usd " +
          "FROM equity_history_hourly WHERE ts_hour >= ? AND ts_hour < ? ORDER BY ts_hour",
        )
        .all(cutoff, Date.now() - RETENTION_RAW_MS) as EquityHistoryRow[];
      return [...rollup, ...raw];
    }
    return raw;
  }

  /**
   * Return funding rate history for a specific coin over the last `rangeMs` ms.
   * Unions raw and hourly rollup tables when the range exceeds 7 days.
   */
  getFundingHistory(coin: string, rangeMs: number): FundingSampleRow[] {
    const cutoff = Date.now() - rangeMs;
    const raw = this.db
      .prepare(
        "SELECT ts, coin, venue, rate_hourly FROM funding_samples " +
        "WHERE coin = ? AND ts >= ? ORDER BY ts",
      )
      .all(coin, cutoff) as FundingSampleRow[];

    if (rangeMs > RETENTION_RAW_MS) {
      const rollup = this.db
        .prepare(
          "SELECT ts_hour AS ts, coin, venue, avg_rate_hourly AS rate_hourly " +
          "FROM funding_samples_hourly " +
          "WHERE coin = ? AND ts_hour >= ? AND ts_hour < ? ORDER BY ts_hour",
        )
        .all(coin, cutoff, Date.now() - RETENTION_RAW_MS) as FundingSampleRow[];
      return [...rollup, ...raw];
    }
    return raw;
  }

  // ── Retention / rollup ───────────────────────────────────────────────────────

  /**
   * Roll up rows older than 7 days into hourly buckets, then delete the raw rows.
   * Safe to call periodically (e.g. every hour). All work happens in transactions.
   */
  runRetentionPolicy(): void {
    const cutoff = Date.now() - RETENTION_RAW_MS;
    try {
      this.db.transaction(() => {
        // Equity: roll up → hourly, then delete raws
        this.db.prepare(`
          INSERT OR IGNORE INTO equity_history_hourly (ts_hour, avg_equity_usd, sample_count)
          SELECT (ts / ${HOUR_MS}) * ${HOUR_MS},
                 AVG(equity_usd),
                 COUNT(*)
          FROM equity_history
          WHERE ts < ?
          GROUP BY (ts / ${HOUR_MS})
        `).run(cutoff);
        this.db.prepare("DELETE FROM equity_history WHERE ts < ?").run(cutoff);

        // Funding: roll up → hourly per (coin, venue), then delete raws
        this.db.prepare(`
          INSERT OR IGNORE INTO funding_samples_hourly (ts_hour, coin, venue, avg_rate_hourly, sample_count)
          SELECT (ts / ${HOUR_MS}) * ${HOUR_MS},
                 coin,
                 venue,
                 AVG(rate_hourly),
                 COUNT(*)
          FROM funding_samples
          WHERE ts < ?
          GROUP BY (ts / ${HOUR_MS}), coin, venue
        `).run(cutoff);
        this.db.prepare("DELETE FROM funding_samples WHERE ts < ?").run(cutoff);
      })();
    } catch (e) {
      console.warn("[logger] Retention policy failed:", (e as Error).message);
    }
  }

  close(): void {
    this.db.close();
    console.log("[logger] Database closed");
  }
}
