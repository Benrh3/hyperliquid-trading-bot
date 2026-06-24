import { describe, it, expect } from "vitest";
import { Logger } from "../logger.js";

describe("getBotRealisedStats", () => {
  it("reconstructs trade count and realised P&L from the trades table", () => {
    const logger = new Logger(":memory:");

    // Simulate 3 successful closed trades for trend-follow on SOL
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (logger as any).db;
    const insert = db.prepare(
      "INSERT INTO trades (order_id, coin, side, size, price, pnl, strategy, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("ord-1", "SOL", "long",  1.0, 150.0, 2.50,  "trend-follow", 1);
    insert.run("ord-2", "SOL", "short", 1.0, 148.0, -1.20, "trend-follow", 1);
    insert.run("ord-3", "SOL", "long",  1.0, 149.0, 0.80,  "trend-follow", 1);
    // A failed trade (should not count)
    insert.run("ord-4", "SOL", "long",  0,   149.0, null,   "trend-follow", 0);
    // A trade for a different coin (should not count)
    insert.run("ord-5", "BTC", "long",  0.01, 60000, 5.0,   "trend-follow", 1);
    // A trade for a different strategy (should not count)
    insert.run("ord-6", "SOL", "long",  1.0, 150.0, 1.0,   "confluence",   1);

    const stats = logger.getBotRealisedStats("trend-follow", "SOL");
    expect(stats.tradeCount).toBe(3);
    expect(stats.realisedPnl).toBeCloseTo(2.10); // 2.50 - 1.20 + 0.80
  });

  it("returns zero for a bot with no trades", () => {
    const logger = new Logger(":memory:");
    const stats = logger.getBotRealisedStats("confluence", "ETH");
    expect(stats.tradeCount).toBe(0);
    expect(stats.realisedPnl).toBe(0);
  });
});
