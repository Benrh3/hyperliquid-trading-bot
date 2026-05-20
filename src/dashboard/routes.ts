import { Router } from "express";
import { RSI } from "technicalindicators";
import { config } from "../config.js";
import type { Logger } from "../logger.js";
import type { BotState } from "./server.js";
import type { Strategy } from "../strategy/base.js";
import type { Feed } from "../feed.js";

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

export function createRouter(
  logger: Logger,
  state: BotState,
  strategies: Strategy[] = [],
  feed?: Feed,
): Router {
  const router = Router();

  // ── Page routes ─────────────────────────────────────────────────────────

  router.get("/", (_req, res) => {
    const trades = logger.getRecentTrades(1000);
    const events = logger.getEventLog(20);
    res.render("index", {
      state,
      events,
      tradeCount: trades.length,
      uptime: formatUptime(process.uptime()),
      coin:     config.exchange.coin,
      network:  config.exchange.network,
      strategy: config.strategy.type,
      interval: state.currentInterval,
    });
  });

  router.get("/trades", (_req, res) => {
    const trades = logger.getRecentTrades(100);
    res.render("trades", {
      trades,
      coin: config.exchange.coin,
    });
  });

  router.get("/strategies", (_req, res) => {
    const strategyData = strategies.map((s) => ({
      name:  s.name,
      state: s.getState?.() ?? {},
    }));
    res.render("strategies", {
      strategies: strategyData,
      coin:    config.exchange.coin,
      network: config.exchange.network,
    });
  });

  // ── JSON API ─────────────────────────────────────────────────────────────

  router.get("/api/candles", (_req, res) => {
    const candles = state.candleHistory;

    if (candles.length === 0) {
      res.json({ candles: [], volume: [], rsi: [], markers: [], spread: [] });
      return;
    }

    const candleData = candles.map((c) => ({
      time:  Math.floor(c.timestamp / 1000),
      open:  c.open,
      high:  c.high,
      low:   c.low,
      close: c.close,
    }));

    const volumeData = candles.map((c) => ({
      time:  Math.floor(c.timestamp / 1000),
      value: c.volume,
      color: c.close >= c.open ? "rgba(63,185,80,0.5)" : "rgba(248,81,73,0.5)",
    }));

    // RSI(14) — first value aligns at candle index 14
    const closes = candles.map((c) => c.close);
    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    const rsiData = rsiValues.map((value, i) => ({
      time: Math.floor(candles[i + 14].timestamp / 1000),
      value,
    }));

    // Spread line — align with candle timestamps
    const spreadData = state.spreadHistory.map((s) => ({
      time:  Math.floor(s.t / 1000),
      value: s.value,
    }));

    // Signal markers snapped to nearest candle bar
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
            time:     timeSecs,
            position: sig.side === "long" ? "belowBar" : "aboveBar",
            color:    sig.side === "long" ? "#3fb950" : "#f85149",
            shape:    sig.side === "long" ? "arrowUp" : "arrowDown",
            text:     sig.side === "long" ? "L" : "S",
          }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => (a.time as number) - (b.time as number));

    res.json({ candles: candleData, volume: volumeData, rsi: rsiData, markers, spread: spreadData });
  });

  router.get("/api/status", (_req, res) => {
    const trades = logger.getRecentTrades(1000);
    const spread = state.lastAsk - state.lastBid;
    const spreadPct = state.lastBid > 0 ? (spread / state.lastBid) * 100 : 0;
    res.json({
      price:       state.lastPrice,
      bid:         state.lastBid,
      ask:         state.lastAsk,
      spread,
      spreadPct,
      lastUpdate:  state.lastUpdate,
      signalCount: state.signalCount,
      tradeCount:  trades.length,
      uptime:      formatUptime(process.uptime()),
      network:     config.exchange.network,
      coin:        config.exchange.coin,
      strategy:    config.strategy.type,
      interval:    state.currentInterval,
    });
  });

  router.get("/api/events", (_req, res) => {
    res.json(logger.getEventLog(20));
  });

  router.get("/api/funding-rate", (_req, res) => {
    const fr = strategies.find((s) => s.name === "funding-rate");
    if (!fr || !fr.getState) {
      res.json({ error: "Funding rate strategy not active" });
      return;
    }
    res.json(fr.getState());
  });

  router.get("/api/prices", (_req, res) => {
    res.json(state.priceHistory);
  });

  router.post("/api/interval", async (req, res) => {
    const { interval } = req.body as { interval?: string };
    if (!interval) {
      res.status(400).json({ error: "interval required" });
      return;
    }
    if (!feed) {
      res.status(503).json({ error: "Feed not available" });
      return;
    }

    // Clear chart history — will be repopulated via bus events from changeInterval
    state.candleHistory = [];
    state.spreadHistory = [];

    await feed.changeInterval(interval);
    state.currentInterval = feed.getInterval();

    res.json({ ok: true, interval: state.currentInterval });
  });

  return router;
}
