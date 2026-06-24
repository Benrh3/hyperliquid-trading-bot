import { describe, it, expect } from "vitest";
import { Logger } from "../logger.js";

describe("getBotRealisedStats", () => {
  it("reconstructs from the trades table using strategy+coin fallback for legacy rows", () => {
    const logger = new Logger(":memory:");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (logger as any).db;
    const insert = db.prepare(
      "INSERT INTO trades (order_id, coin, side, size, price, pnl, strategy, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("ord-1", "SOL", "long",  1.0, 150.0, 2.50,  "trend-follow", 1);
    insert.run("ord-2", "SOL", "short", 1.0, 148.0, -1.20, "trend-follow", 1);
    insert.run("ord-3", "SOL", "long",  1.0, 149.0, 0.80,  "trend-follow", 1);
    insert.run("ord-4", "SOL", "long",  0,   149.0, null,   "trend-follow", 0); // failed
    insert.run("ord-5", "BTC", "long",  0.01, 60000, 5.0,   "trend-follow", 1); // different coin

    const stats = logger.getBotRealisedStats("trend-follow", "SOL");
    expect(stats.tradeCount).toBe(3);
    expect(stats.realisedPnl).toBeCloseTo(2.10);
  });

  it("returns zero for a bot with no trades", () => {
    const logger = new Logger(":memory:");
    const stats = logger.getBotRealisedStats("confluence", "ETH");
    expect(stats.tradeCount).toBe(0);
    expect(stats.realisedPnl).toBe(0);
  });

  it("keys on bot_id when available — two bots same strategy+coin don't collide", () => {
    const logger = new Logger(":memory:");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (logger as any).db;
    const insert = db.prepare(
      "INSERT INTO trades (order_id, coin, side, size, price, pnl, strategy, success, bot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // Bot A: 2 trades, net +3.00
    insert.run("a-1", "SOL", "long",  1, 150, 2.00, "trend-follow", 1, "bot-a");
    insert.run("a-2", "SOL", "short", 1, 148, 1.00, "trend-follow", 1, "bot-a");
    // Bot B: 1 trade, net -0.50
    insert.run("b-1", "SOL", "long",  1, 149, -0.50, "trend-follow", 1, "bot-b");

    const statsA = logger.getBotRealisedStats("trend-follow", "SOL", "bot-a");
    expect(statsA.tradeCount).toBe(2);
    expect(statsA.realisedPnl).toBeCloseTo(3.00);

    const statsB = logger.getBotRealisedStats("trend-follow", "SOL", "bot-b");
    expect(statsB.tradeCount).toBe(1);
    expect(statsB.realisedPnl).toBeCloseTo(-0.50);
  });

  it("includes pre-migration rows (bot_id NULL) in the fallback for the matching bot", () => {
    const logger = new Logger(":memory:");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (logger as any).db;
    const insert = db.prepare(
      "INSERT INTO trades (order_id, coin, side, size, price, pnl, strategy, success, bot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // Legacy row (no bot_id)
    insert.run("old-1", "SOL", "long", 1, 150, 1.50, "trend-follow", 1, null);
    // New row with bot_id
    insert.run("new-1", "SOL", "long", 1, 151, 0.75, "trend-follow", 1, "bot-a");

    const stats = logger.getBotRealisedStats("trend-follow", "SOL", "bot-a");
    // Should include both: the bot_id match + the NULL fallback
    expect(stats.tradeCount).toBe(2);
    expect(stats.realisedPnl).toBeCloseTo(2.25);
  });
});
