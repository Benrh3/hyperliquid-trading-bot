import { Router } from "express";
import { config } from "../config.js";
import type { Logger } from "../logger.js";
import type { BotState } from "./server.js";

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

export function createRouter(logger: Logger, state: BotState): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const trades = logger.getRecentTrades(1000);
    const events = logger.getEventLog(10);
    res.render("index", {
      state,
      events,
      tradeCount: trades.length,
      uptime: formatUptime(process.uptime()),
      coin: config.exchange.coin,
      network: config.exchange.network,
      strategy: config.strategy.type,
      interval: config.strategy.interval,
    });
  });

  router.get("/trades", (_req, res) => {
    const trades = logger.getRecentTrades(100);
    res.render("trades", {
      trades,
      coin: config.exchange.coin,
    });
  });

  router.get("/api/prices", (_req, res) => {
    res.json(state.priceHistory);
  });

  router.get("/api/status", (_req, res) => {
    const trades = logger.getRecentTrades(1000);
    res.json({
      price: state.lastPrice,
      bid: state.lastBid,
      ask: state.lastAsk,
      lastUpdate: state.lastUpdate,
      signalCount: state.signalCount,
      tradeCount: trades.length,
      uptime: formatUptime(process.uptime()),
      network: config.exchange.network,
      coin: config.exchange.coin,
      strategy: config.strategy.type,
    });
  });

  return router;
}
