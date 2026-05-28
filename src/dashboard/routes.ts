import { Router } from "express";
import { RSI } from "technicalindicators";
import { config, coins } from "../config.js";
import { runBacktest, fetchCandles, runFundingBasisBacktest, fetchFundingHistory, BACKTEST_INTERVAL_MS } from "../backtest.js";
import { CANDLE_STRATEGIES, STRATEGY_REGISTRY } from "../strategy/registry.js";
import type { Logger } from "../logger.js";
import type { BotState } from "./server.js";
import type { Strategy } from "../strategy/base.js";
import type { Feed } from "../feed.js";
import type { Executor } from "../executor.js";
import type { LaneManager, LanesFile } from "../lane-manager.js";

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
  executor?: Executor,
  laneManager?: LaneManager,
): Router {
  const router = Router();

  // ── Page routes ─────────────────────────────────────────────────────────

  router.get("/", (_req, res) => {
    const trades = logger.getRecentTrades(1000);
    const events = logger.getEventLog(20);
    const primaryCoin  = coins[0];
    const primaryPrice = state.lastPrices[primaryCoin] ?? { mid: 0, bid: 0, ask: 0 };
    res.render("index", {
      state,
      events,
      tradeCount:  trades.length,
      uptime:      formatUptime(process.uptime()),
      coins,
      coin:        primaryCoin,
      network:     config.exchange.network,
      strategy:    config.strategy.type,
      interval:    state.currentInterval,
      primaryPrice,
    });
  });

  router.get("/trades", (_req, res) => {
    const total  = logger.getTradeCount();
    const trades = logger.getTrades(100, 0);
    res.render("trades", {
      trades,
      total,
      coin: config.exchange.coin,
    });
  });

  router.get("/api/trades", (req, res) => {
    const limit  = Math.min(parseInt(typeof req.query.limit  === "string" ? req.query.limit  : "100") || 100, 500);
    const offset = parseInt(typeof req.query.offset === "string" ? req.query.offset : "0") || 0;
    const trades = logger.getTrades(limit, offset);
    const total  = logger.getTradeCount();
    res.json({ trades, total, hasMore: offset + trades.length < total });
  });

  router.get("/backtest", (_req, res) => {
    res.render("backtest", {
      coin:    config.exchange.coin,
      network: config.exchange.network,
    });
  });

  router.get("/learn", (_req, res) => {
    res.render("learn", {
      network:  config.exchange.network,
      coin:     config.exchange.coin,
      registry: STRATEGY_REGISTRY,
    });
  });

  router.get("/settings", (_req, res) => {
    res.render("settings", {
      network:   config.exchange.network,
      coin:      config.exchange.coin,
      registry:  STRATEGY_REGISTRY,
      lanesFile: laneManager?.getLanesFile() ?? { lanes: [] },
    });
  });

  // ── Lane API ─────────────────────────────────────────────────────────────

  router.get("/api/lanes", (_req, res) => {
    res.json(laneManager?.getLaneStates() ?? []);
  });

  router.post("/api/lanes/config", async (req, res) => {
    if (!laneManager) {
      res.status(503).json({ error: "Lane manager not initialised" });
      return;
    }
    try {
      const body = req.body as LanesFile;
      if (!Array.isArray(body?.lanes)) {
        res.status(400).json({ error: "lanes array required" });
        return;
      }
      await laneManager.applyConfig(body);
      res.json({ ok: true });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      res.status(400).json({ error: error.message });
    }
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

  router.get("/api/candles", (req, res) => {
    const coinParam = typeof req.query.coin === "string" ? req.query.coin : coins[0];
    const candles   = state.candleHistory[coinParam] ?? [];

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
    const spreadData = (state.spreadHistory[coinParam] ?? []).map((s) => ({
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
    const trades       = logger.getRecentTrades(1000);
    const primaryCoin  = coins[0];
    const pp           = state.lastPrices[primaryCoin] ?? { mid: 0, bid: 0, ask: 0 };
    const spread       = pp.ask - pp.bid;
    const spreadPct    = pp.bid > 0 ? (spread / pp.bid) * 100 : 0;
    res.json({
      price:       pp.mid,
      bid:         pp.bid,
      ask:         pp.ask,
      spread,
      spreadPct,
      prices:      state.lastPrices,
      lastUpdate:  state.lastUpdate,
      signalCount: state.signalCount,
      tradeCount:  trades.length,
      uptime:      formatUptime(process.uptime()),
      network:     config.exchange.network,
      coin:        primaryCoin,
      coins,
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
    res.json(state.lastPrices);
  });

  router.get("/api/backtest/funding", async (req, res) => {
    try {
      const interval  = (typeof req.query.interval === "string" ? req.query.interval : null) ?? "1h";
      const limit     = Math.min(parseInt(typeof req.query.limit === "string" ? req.query.limit : "1000") || 1000, 2000);
      const coin      = coins[0];
      const intervalMs = BACKTEST_INTERVAL_MS[interval] ?? 60_000;
      const endTime   = Date.now();
      const startTime = endTime - limit * intervalMs;

      const records = await fetchFundingHistory(coin, startTime, endTime);
      if (records.length === 0) {
        res.status(400).json({ error: "No funding history returned from exchange" });
        return;
      }

      const result = runFundingBasisBacktest(records);
      res.json({ ...result, coin, interval, limit, fetchedPeriods: records.length });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[backtest/funding] API error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/api/backtest", async (req, res) => {
    try {
      const interval = (typeof req.query.interval === "string" ? req.query.interval : null) ?? "1h";
      const limit    = Math.min(parseInt(typeof req.query.limit === "string" ? req.query.limit : "1000") || 1000, 2000);
      const coin     = coins[0];

      const candles = await fetchCandles(coin, interval, limit);
      if (candles.length === 0) {
        res.status(400).json({ error: "No candle data returned from exchange" });
        return;
      }

      const btOptions = {
        initialEquity:   1000,
        positionSizeUsd: config.risk.maxPositionSizeUsd,
        stopLossPct:     config.risk.stopLossPercent,
      };

      const strategies = CANDLE_STRATEGIES.map((e) => e.factory());
      const results = strategies.map((s) => ({
        name: s.name,
        ...runBacktest(s, candles, btOptions),
      }));

      // Primary result spread at top level for backward compatibility
      const primary = results[0];
      res.json({ ...primary, results, interval, limit, coin, fetchedCandles: candles.length });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[backtest] API error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/api/orderbook", (req, res) => {
    const coinParam = typeof req.query.coin === "string" ? req.query.coin : coins[0];
    res.json(state.orderbooks[coinParam] ?? { coin: coinParam, timestamp: 0, bids: [], asks: [] });
  });

  router.get("/api/pnl", (_req, res) => {
    const position = executor?.getPosition() ?? null;
    const realisedPnl = logger.getSumPnl();
    res.json({
      position,
      unrealisedPnl: position?.unrealisedPnl ?? null,
      unrealisedPnlPercent: position?.unrealisedPnlPercent ?? null,
      realisedPnl,
      equityHistory: state.equityHistory,
    });
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
    for (const c of coins) {
      state.candleHistory[c] = [];
      state.spreadHistory[c] = [];
    }

    await feed.changeInterval(interval);
    state.currentInterval = feed.getInterval();

    res.json({ ok: true, interval: state.currentInterval });
  });

  return router;
}
