import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "fs";
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

export class Logger {
  private db: Database.Database;
  private stmtInsertTrade: Database.Statement;
  private stmtInsertEvent: Database.Statement;

  constructor(dbPath = "data/bot.db") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    const sql = readFileSync(join(process.cwd(), "migrations/001_init.sql"), "utf-8");
    this.db.exec(sql);

    this.stmtInsertTrade = this.db.prepare(`
      INSERT INTO trades (order_id, coin, side, size, price, pnl, strategy, success, error)
      VALUES (@orderId, @coin, @side, @size, @price, @pnl, @strategy, @success, @error)
    `);

    this.stmtInsertEvent = this.db.prepare(`
      INSERT INTO events (module, level, message, data)
      VALUES (@module, @level, @message, @data)
    `);

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
        strategy: config.strategy.type,
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

  getSumPnl(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE pnl IS NOT NULL AND success = 1")
      .get() as { total: number };
    return row.total;
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

  close(): void {
    this.db.close();
    console.log("[logger] Database closed");
  }
}
