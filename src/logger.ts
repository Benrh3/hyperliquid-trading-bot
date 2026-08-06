import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { bus } from "./events.js";
import { config } from "./config.js";
import type { Signal, TradeResult } from "./events.js";

export interface TradeRow {
  id: number;
  order_id: string;
  coin: string;
  side: "long" | "short";
  size: number;
  price: number;
  pnl: number | null;
  fees: number | null;
  strategy: string;
  reason: string | null;
  success: number;
  error: string | null;
  created_at: string;
  bot_id: string | null;
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
export interface SpreadHistoryGap { from: number; to: number; gapMs: number }

// ── Bot archive ───────────────────────────────────────────────────────────────

export interface ArchivedBotRow {
  id:                     string;
  strategy_id:            string;
  display_name:           string;
  coin:                   string;
  timeframe:              string;
  live:                   number;
  execution_mode:         string | null;
  started_at:             number;
  retired_at:             number;
  starting_equity:        number;
  realised_pnl:           number;
  trade_count:            number;
  win_rate:               number | null;
  max_drawdown_pct:       number | null;
  lifetime_hours:         number;
  annualized_return_pct:  number | null;
  realized_sharpe:        number | null;
  wf_strategy_id:         string | null;
  wf_coin:                string | null;
  wf_mean_oos_sharpe:     number | null;
  wf_mean_oos_return_pct: number | null;
  wf_pct_beat_bh:         number | null;
  wf_run_at:              number | null;
}

export interface ArchiveBotInput {
  id:                   string;
  strategyId:           string;
  displayName:          string;
  coin:                 string;
  timeframe:            string;
  live:                 boolean;
  executionMode:        string | null;
  startedAt:            number;
  retiredAt:            number;
  startingEquity:       number;
  realisedPnl:          number;
  tradeCount:           number;
  winRate:              number | null;
  maxDrawdownPct:       number | null;
  lifetimeHours:        number;
  annualizedReturnPct:  number | null;
  realizedSharpe:       number | null;
  wfStrategyId:         string | null;
  wfCoin:               string | null;
  wfMeanOosSharpe:      number | null;
  wfMeanOosReturnPct:   number | null;
  wfPctBeatBh:          number | null;
  wfRunAt:              number | null;
}

export interface BotMetrics {
  winRate:        number | null;
  maxDrawdownPct: number | null;
  realizedSharpe: number | null;
}

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
    this.db.pragma("busy_timeout = 5000");

    // Load all migrations in order
    for (const file of ["001_init.sql", "002_funding_matrix.sql", "006_funding_spread_history.sql", "008_trades_bot_id.sql", "009_trades_fees.sql", "010_spread_history_hourly.sql", "012_bot_archive.sql"]) {
      const p = join(process.cwd(), "migrations", file);
      if (existsSync(p)) {
        try { this.db.exec(readFileSync(p, "utf-8")); }
        catch (e) {
          // ALTER TABLE fails if column already exists — safe to ignore
          if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e;
        }
      }
    }

    this.stmtInsertTrade = this.db.prepare(`
      INSERT INTO trades (order_id, coin, side, size, price, pnl, fees, strategy, success, error, bot_id)
      VALUES (@orderId, @coin, @side, @size, @price, @pnl, @fees, @strategy, @success, @error, @botId)
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
        fees: result.fees ?? null,
        strategy: result.strategy ?? config.strategy.type,
        success: result.success ? 1 : 0,
        error: result.error ?? null,
        botId: result.botId ?? null,
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

  /** Filtered trade query for the enriched Trades view. */
  getFilteredTrades(filters: {
    botId?: string; strategy?: string; coin?: string; success?: number;
    limit?: number; offset?: number;
  }): { trades: TradeRow[]; total: number } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filters.botId)    { clauses.push("bot_id = ?");   params.push(filters.botId); }
    if (filters.strategy) { clauses.push("strategy = ?"); params.push(filters.strategy); }
    if (filters.coin)     { clauses.push("coin = ?");     params.push(filters.coin); }
    if (filters.success !== undefined) { clauses.push("success = ?"); params.push(filters.success); }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const total = (this.db.prepare("SELECT COUNT(*) as n FROM trades" + where).get(...params) as { n: number }).n;
    const limit  = Math.min(filters.limit ?? 200, 500);
    const offset = filters.offset ?? 0;
    const trades = this.db
      .prepare("SELECT * FROM trades" + where + " ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(...params, limit, offset) as TradeRow[];
    return { trades, total };
  }

  /** Summary stats over the current filter for the Trades summary header. */
  getTradeStats(filters?: { botId?: string; strategy?: string; coin?: string }): {
    totalTrades: number; netPnl: number; winRate: number; avgNetPnl: number;
  } {
    const clauses = ["success = 1"];
    const params: string[] = [];
    if (filters?.botId)    { clauses.push("bot_id = ?");   params.push(filters.botId); }
    if (filters?.strategy) { clauses.push("strategy = ?"); params.push(filters.strategy); }
    if (filters?.coin)     { clauses.push("coin = ?");     params.push(filters.coin); }
    const where = " WHERE " + clauses.join(" AND ");

    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt, COALESCE(SUM(pnl),0) as net FROM trades" + where,
    ).get(...params) as { cnt: number; net: number };

    const wins = (this.db.prepare(
      "SELECT COUNT(*) as w FROM trades" + where + " AND pnl > 0",
    ).get(...params) as { w: number }).w;

    return {
      totalTrades: row.cnt,
      netPnl:      row.net,
      winRate:     row.cnt > 0 ? wins / row.cnt : 0,
      avgNetPnl:   row.cnt > 0 ? row.net / row.cnt : 0,
    };
  }

  /** Distinct values for filter dropdowns. */
  getTradeFilterOptions(): { bots: string[]; strategies: string[]; coins: string[] } {
    const bots = (this.db.prepare("SELECT DISTINCT bot_id FROM trades WHERE bot_id IS NOT NULL ORDER BY bot_id").all() as { bot_id: string }[]).map((r) => r.bot_id);
    const strategies = (this.db.prepare("SELECT DISTINCT strategy FROM trades ORDER BY strategy").all() as { strategy: string }[]).map((r) => r.strategy);
    const coins = (this.db.prepare("SELECT DISTINCT coin FROM trades ORDER BY coin").all() as { coin: string }[]).map((r) => r.coin);
    return { bots, strategies, coins };
  }

  getSumPnl(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE pnl IS NOT NULL AND success = 1")
      .get() as { total: number };
    return row.total;
  }

  /**
   * Reconstruct realised trade count and P&L for a bot from the durable trade log.
   * Prefers bot_id (exact, no collision). Falls back to strategy+coin for
   * pre-migration rows that lack bot_id.
   */
  getBotRealisedStats(strategy: string, coin: string, botId?: string): { tradeCount: number; realisedPnl: number } {
    if (botId) {
      // Rows with this bot_id + fallback rows with matching strategy+coin but no bot_id.
      // pnl IS NOT NULL filters to closed-position rows only; open-trade rows (pnl = NULL)
      // are entry records only and would inflate the count with $0 contribution.
      const row = this.db.prepare(
        "SELECT COUNT(*) as cnt, COALESCE(SUM(pnl), 0) as pnl FROM trades WHERE success = 1 AND pnl IS NOT NULL AND (bot_id = ? OR (bot_id IS NULL AND strategy = ? AND coin = ?))",
      ).get(botId, strategy, coin) as { cnt: number; pnl: number };
      return { tradeCount: row.cnt, realisedPnl: row.pnl };
    }
    // Legacy path — no bot_id available
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt, COALESCE(SUM(pnl), 0) as pnl FROM trades WHERE strategy = ? AND coin = ? AND success = 1 AND pnl IS NOT NULL",
    ).get(strategy, coin) as { cnt: number; pnl: number };
    return { tradeCount: row.cnt, realisedPnl: row.pnl };
  }

  /**
   * Returns per-bot orphaned-open statistics: bots where the number of
   * pnl=NULL (open-trade) rows exceeds pnl IS NOT NULL (close-trade) rows.
   *
   * @param inMemoryOpenBotIds  Bot IDs that currently hold an open in-memory
   *   position.  One open row per such bot is *legitimate* (the live position
   *   has no close row yet), so the count is decremented by 1 for each.
   *   Pass this when calling periodically; omit at startup (bot.position is
   *   always null immediately after a restart).
   */
  getOrphanedOpenStats(
    inMemoryOpenBotIds?: ReadonlySet<string>,
  ): Array<{ botId: string; coin: string; strategy: string; orphanCount: number }> {
    const opens = this.db.prepare(
      "SELECT bot_id, coin, strategy, COUNT(*) as cnt FROM trades WHERE success = 1 AND pnl IS NULL AND bot_id IS NOT NULL GROUP BY bot_id, coin, strategy",
    ).all() as Array<{ bot_id: string; coin: string; strategy: string; cnt: number }>;

    const closes = this.db.prepare(
      "SELECT bot_id, COUNT(*) as cnt FROM trades WHERE success = 1 AND pnl IS NOT NULL AND bot_id IS NOT NULL GROUP BY bot_id",
    ).all() as Array<{ bot_id: string; cnt: number }>;

    const closeMap = new Map(closes.map((r) => [r.bot_id, r.cnt]));
    return opens
      .map((r) => {
        const inMemAdj = inMemoryOpenBotIds?.has(r.bot_id) ? 1 : 0;
        return {
          botId:       r.bot_id,
          coin:        r.coin,
          strategy:    r.strategy,
          orphanCount: r.cnt - (closeMap.get(r.bot_id) ?? 0) - inMemAdj,
        };
      })
      .filter((r) => r.orphanCount > 0);
  }

  /** Epoch-ms of the earliest orphaned open row for the given bot_id. */
  getEarliestOrphanTimestamp(botId: string): number {
    const row = this.db.prepare(
      "SELECT strftime('%s', MIN(created_at)) * 1000 as ts FROM trades WHERE bot_id = ? AND pnl IS NULL AND success = 1",
    ).get(botId) as { ts: number | null };
    return row.ts ?? (Date.now() - 365 * 24 * 3_600_000);
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
   * Delete all trades rows for the given bot_id and return the deleted count.
   * Also deletes legacy rows where bot_id IS NULL but strategy+coin match
   * (written before the bot_id column existed) so the P&L stays zeroed after restart.
   */
  deleteTradesForBot(botId: string, strategy?: string, coin?: string): number {
    let deleted = this.db.prepare("DELETE FROM trades WHERE bot_id = ?").run(botId).changes;
    if (strategy && coin) {
      deleted += this.db.prepare(
        "DELETE FROM trades WHERE bot_id IS NULL AND strategy = ? AND coin = ?",
      ).run(strategy, coin).changes;
    }
    return deleted;
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

  /**
   * Scan the raw funding_spread_history table for consecutive-timestamp gaps
   * larger than `thresholdMs`.  Only raw rows (≤7 days) are examined — the
   * hourly rollup can't detect sub-hour gaps, so there's nothing useful to check
   * beyond the raw retention window.
   *
   * Returns one entry per gap, sorted chronologically.
   */
  getSpreadHistoryGaps(sinceMs: number, thresholdMs: number): SpreadHistoryGap[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT ts FROM funding_spread_history " +
        "WHERE ts >= ? ORDER BY ts ASC",
      )
      .all(sinceMs) as Array<{ ts: number }>;

    if (rows.length < 2) return [];

    const gaps: SpreadHistoryGap[] = [];
    for (let i = 1; i < rows.length; i++) {
      const gapMs = rows[i].ts - rows[i - 1].ts;
      if (gapMs > thresholdMs) {
        gaps.push({ from: rows[i - 1].ts, to: rows[i].ts, gapMs });
      }
    }
    return gaps;
  }

  // ── Retention / rollup ───────────────────────────────────────────────────────

  /**
   * Roll up raw rows into hourly buckets, then prune raw rows older than 7 days.
   *
   * Rollup and prune use SEPARATE cutoffs so hourly tables stay current:
   *   - rollup: all completed hours (up to the start of the current hour)
   *   - prune:  only raw rows older than 7 days
   *
   * INSERT OR IGNORE makes re-processing idempotent — already-rolled-up hours
   * are skipped. Each table runs independently so one failure doesn't block others.
   * Deletes are batched (50K rows/pass) to keep transactions short under WAL.
   */
  runRetentionPolicy(): void {
    const hourFloor   = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const pruneCutoff = Date.now() - RETENTION_RAW_MS;
    const BATCH       = 50_000;

    // Equity: roll up → hourly, then prune old raws
    this._retainTable("equity", () => {
      this.db.prepare(`
        INSERT OR IGNORE INTO equity_history_hourly (ts_hour, avg_equity_usd, sample_count)
        SELECT (ts / ${HOUR_MS}) * ${HOUR_MS}, AVG(equity_usd), COUNT(*)
        FROM equity_history WHERE ts < ?
        GROUP BY (ts / ${HOUR_MS})
      `).run(hourFloor);
      this._batchDelete("equity_history", "ts", pruneCutoff, BATCH);
    });

    // Funding samples: roll up → hourly per (coin, venue), then prune old raws
    this._retainTable("funding_samples", () => {
      this.db.prepare(`
        INSERT OR IGNORE INTO funding_samples_hourly (ts_hour, coin, venue, avg_rate_hourly, sample_count)
        SELECT (ts / ${HOUR_MS}) * ${HOUR_MS}, coin, venue, AVG(rate_hourly), COUNT(*)
        FROM funding_samples WHERE ts < ?
        GROUP BY (ts / ${HOUR_MS}), coin, venue
      `).run(hourFloor);
      this._batchDelete("funding_samples", "ts", pruneCutoff, BATCH);
    });

    // Funding spread history: roll up → hourly per coin, then prune old raws
    // (WITHOUT ROWID table — cannot use rowid-based batch delete)
    this._retainTable("funding_spread_history", () => {
      this.db.prepare(`
        INSERT OR IGNORE INTO funding_spread_history_hourly (ts_hour, coin, avg_hl_funding, avg_dydx_funding, avg_spread_abs, avg_hl_oi_usd, sample_count)
        SELECT (ts / ${HOUR_MS}) * ${HOUR_MS}, coin, AVG(hl_funding), AVG(dydx_funding), AVG(spread_abs), AVG(hl_oi_usd), COUNT(*)
        FROM funding_spread_history WHERE ts < ?
        GROUP BY (ts / ${HOUR_MS}), coin
      `).run(hourFloor);
      this._batchDeleteByTs("funding_spread_history", pruneCutoff, BATCH);
    });

    // Events: prune older than 30 days (no rollup — operational log only)
    const eventCutoff = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    this._retainTable("events", () => {
      this._batchDeleteStr("events", "created_at", eventCutoff, BATCH);
    });
  }

  private _retainTable(label: string, work: () => void): void {
    try {
      work();
    } catch (e) {
      console.warn(`[logger] Retention (${label}) failed:`, (e as Error).message);
    }
  }

  private _batchDelete(table: string, tsCol: string, cutoff: number, batch: number): void {
    const stmt = this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${tsCol} < ? LIMIT ?)`);
    let total = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = stmt.run(cutoff, batch);
      total += result.changes;
      if (result.changes < batch) break;
    }
    if (total > 0) console.log(`[logger] Retention: pruned ${total} rows from ${table}`);
  }

  private _batchDeleteStr(table: string, col: string, cutoff: string, batch: number): void {
    const stmt = this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${col} < ? LIMIT ?)`);
    let total = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = stmt.run(cutoff, batch);
      total += result.changes;
      if (result.changes < batch) break;
    }
    if (total > 0) console.log(`[logger] Retention: pruned ${total} rows from ${table}`);
  }

  private _batchDeleteByTs(table: string, cutoff: number, batch: number): void {
    const stmt = this.db.prepare(`DELETE FROM ${table} WHERE ts < ? LIMIT ?`);
    let total = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = stmt.run(cutoff, batch);
      total += result.changes;
      if (result.changes < batch) break;
    }
    if (total > 0) console.log(`[logger] Retention: pruned ${total} rows from ${table}`);
  }

  // ── Bot archive ─────────────────────────────────────────────────────────────

  archiveBot(data: ArchiveBotInput): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO bot_archive (
        id, strategy_id, display_name, coin, timeframe, live, execution_mode,
        started_at, retired_at, starting_equity,
        realised_pnl, trade_count, win_rate, max_drawdown_pct,
        lifetime_hours, annualized_return_pct, realized_sharpe,
        wf_strategy_id, wf_coin, wf_mean_oos_sharpe, wf_mean_oos_return_pct,
        wf_pct_beat_bh, wf_run_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )
    `).run(
      data.id, data.strategyId, data.displayName, data.coin, data.timeframe,
      data.live ? 1 : 0, data.executionMode,
      data.startedAt, data.retiredAt, data.startingEquity,
      data.realisedPnl, data.tradeCount, data.winRate ?? null, data.maxDrawdownPct ?? null,
      data.lifetimeHours, data.annualizedReturnPct ?? null, data.realizedSharpe ?? null,
      data.wfStrategyId, data.wfCoin, data.wfMeanOosSharpe ?? null,
      data.wfMeanOosReturnPct ?? null, data.wfPctBeatBh ?? null, data.wfRunAt ?? null,
    );
  }

  getArchivedBots(): ArchivedBotRow[] {
    return this.db
      .prepare("SELECT * FROM bot_archive ORDER BY retired_at DESC")
      .all() as ArchivedBotRow[];
  }

  getArchivedBot(id: string): ArchivedBotRow | null {
    return this.db
      .prepare("SELECT * FROM bot_archive WHERE id = ?")
      .get(id) as ArchivedBotRow | null;
  }

  /**
   * Compute trade-level metrics for a bot at retire time.
   * Reads the bot's closed trade rows (pnl IS NOT NULL) sorted chronologically.
   * Returns null fields when the bot has fewer than 2 closed trades (not enough data).
   */
  computeBotMetrics(botId: string, startingEquity: number): BotMetrics {
    const trades = this.db.prepare(
      "SELECT pnl, price, size FROM trades WHERE bot_id = ? AND success = 1 AND pnl IS NOT NULL ORDER BY created_at ASC",
    ).all(botId) as Array<{ pnl: number; price: number; size: number }>;

    if (trades.length === 0) return { winRate: null, maxDrawdownPct: null, realizedSharpe: null };

    // Win rate
    const wins    = trades.filter((t) => t.pnl > 0).length;
    const winRate = wins / trades.length;

    // Max drawdown from running equity curve
    let equity       = startingEquity;
    let peak         = startingEquity;
    let maxDrawdownPct = 0;
    for (const t of trades) {
      equity += t.pnl;
      if (equity > peak) peak = equity;
      if (peak > 0) {
        const dd = (peak - equity) / peak * 100;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      }
    }

    // Realized Sharpe (mirrors backtest.ts formula — trade-level returns)
    if (trades.length < 2) {
      return { winRate, maxDrawdownPct, realizedSharpe: null };
    }
    const returns  = trades.map((t) => t.pnl / Math.max(t.price * t.size, 1e-9));
    const mean     = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std      = Math.sqrt(variance);
    const realizedSharpe = std > 1e-10 ? (mean / std) * Math.sqrt(returns.length) : null;

    return { winRate, maxDrawdownPct, realizedSharpe };
  }

  close(): void {
    this.db.close();
    console.log("[logger] Database closed");
  }
}
