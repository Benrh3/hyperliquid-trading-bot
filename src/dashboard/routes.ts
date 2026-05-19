import { Router } from "express";
import { RSI } from "technicalindicators";
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

  router.get("/api/candles", (_req, res) => {
    const candles = state.candleHistory;

    if (candles.length === 0) {
      res.json({ candles: [], volume: [], rsi: [], markers: [] });
      return;
    }

    // Candle + volume series data (time in seconds for lightweight-charts)
    const candleData = candles.map((c) => ({
      time: Math.floor(c.timestamp / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    const volumeData = candles.map((c) => ({
      time: Math.floor(c.timestamp / 1000),
      value: c.volume,
      color: c.close >= c.open ? "rgba(63,185,80,0.5)" : "rgba(248,81,73,0.5)",
    }));

    // RSI (period 14) — aligns at index 14 of the candle array
    const closes = candles.map((c) => c.close);
    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    const rsiData = rsiValues.map((value, i) => ({
      time: Math.floor(candles[i + 14].timestamp / 1000),
      value,
    }));

    // Signal markers from the event log
    const candleTimes = candleData.map((c) => c.time);
    function snapToCandle(sigSecs: number): number {
      let best = candleTimes[0];
      for (const t of candleTimes) {
        if (t <= sigSecs) best = t;
        else break;
      }
      return best;
    }

    const events = logger.getEventLog(500);
    const markers = events
      .filter((e) => e.module === "strategy" && e.level === "info" && e.data)
      .flatMap((e) => {
        try {
          const sig = JSON.parse(e.data as string) as { side: string; timestamp: number };
          const timeSecs = snapToCandle(Math.floor(sig.timestamp / 1000));
          return [{
            time: timeSecs,
            position: sig.side === "long" ? "belowBar" : "aboveBar",
            color: sig.side === "long" ? "#3fb950" : "#f85149",
            shape: sig.side === "long" ? "arrowUp" : "arrowDown",
            text: sig.side === "long" ? "L" : "S",
          }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => (a.time as number) - (b.time as number));

    res.json({ candles: candleData, volume: volumeData, rsi: rsiData, markers });
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
