import { Router } from "express";
import { RSI } from "technicalindicators";
import { config, coins, API_URL } from "../config.js";
import { runBacktest, fetchCandles, runFundingBasisBacktest, fetchFundingHistory, BACKTEST_INTERVAL_MS } from "../backtest.js";
import { CANDLE_STRATEGIES, STRATEGY_REGISTRY } from "../strategy/registry.js";
import type { Logger } from "../logger.js";
import type { BotState } from "./server.js";
import type { Strategy } from "../strategy/base.js";
import type { Feed } from "../feed.js";
import type { Executor } from "../executor.js";
import type { BotManager, BotsFile } from "../bot-manager.js";

// ── Funding rate cache & helpers ─────────────────────────────────────────────

const HL_INFO_ENDPOINT = `${API_URL}/info`;

interface CachedFundingItem {
  coin: string;
  currentRate: number;
  annualizedRate: number;
  predictedNextRate: number;
  avgRate24h: number;
  attractiveness: "green" | "amber" | "red";
  volume24h: number;
}

interface FundingHistEntry {
  rates: number[];
  times: number[];
  expiresAt: number;
}

// Symbol → full name for display in dropdowns
const COIN_NAMES: Record<string, string> = {
  BTC:      "Bitcoin",
  ETH:      "Ethereum",
  SOL:      "Solana",
  HYPE:     "Hyperliquid",
  XRP:      "Ripple",
  DOGE:     "Dogecoin",
  ADA:      "Cardano",
  AVAX:     "Avalanche",
  LINK:     "Chainlink",
  DOT:      "Polkadot",
  MATIC:    "Polygon",
  UNI:      "Uniswap",
  ATOM:     "Cosmos",
  LTC:      "Litecoin",
  NEAR:     "NEAR Protocol",
  ARB:      "Arbitrum",
  OP:       "Optimism",
  APT:      "Aptos",
  SUI:      "Sui",
  INJ:      "Injective",
  TIA:      "Celestia",
  SEI:      "Sei",
  PYTH:     "Pyth Network",
  JTO:      "Jito",
  JUP:      "Jupiter",
  W:        "Wormhole",
  ZRO:      "LayerZero",
  RNDR:     "Render",
  FTM:      "Fantom",
  AAVE:     "Aave",
  WLD:      "Worldcoin",
  WIF:      "dogwifhat",
  BONK:     "Bonk",
  ORDI:     "Ordinals",
  STRK:     "Starknet",
  MANTA:    "Manta Network",
  NEIRO:    "Neiro",
  GOAT:     "Goat",
  PNUT:     "Peanut the Squirrel",
  MOVE:     "Movement",
  VIRTUAL:  "Virtuals Protocol",
  AI16Z:    "ai16z",
  TRUMP:    "Official Trump",
  BERA:     "Berachain",
  IP:       "Story Protocol",
  KAITO:    "Kaito",
  LAYER:    "Solayer",
  SHIB:     "Shiba Inu",
};

function coinDisplayName(coin: string): string {
  return COIN_NAMES[coin] ? `${coin} - ${COIN_NAMES[coin]}` : coin;
}

let fundingTopCache: { items: CachedFundingItem[]; expiresAt: number } | null = null;
const fundingHistCache = new Map<string, FundingHistEntry>();

async function hlPost<T>(body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(HL_INFO_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HL API ${resp.status}: ${resp.statusText}`);
  return resp.json() as Promise<T>;
}

async function getCoinHistory(coin: string): Promise<{ rates: number[]; times: number[] }> {
  const now = Date.now();
  const cached = fundingHistCache.get(coin);
  if (cached && cached.expiresAt > now) return { rates: cached.rates, times: cached.times };

  type HistRecord = { fundingRate: string; time: number };
  const records = await hlPost<HistRecord[]>({
    type: "fundingHistory",
    coin,
    startTime: now - 7 * 24 * 3_600_000,
  });
  const rates = records.map((r) => parseFloat(r.fundingRate));
  const times = records.map((r) => Number(r.time));
  fundingHistCache.set(coin, { rates, times, expiresAt: now + 3_600_000 });
  return { rates, times };
}

function computeAttractiveness(rates: number[]): "green" | "amber" | "red" {
  if (rates.length === 0) return "red";
  const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
  const negFrac = rates.filter((r) => r < 0).length / rates.length;
  if (avg <= 0 || negFrac > 0.4) return "red";
  const absRates = rates.map(Math.abs).sort((a, b) => a - b);
  const median = absRates[Math.floor(absRates.length / 2)];
  const hasSpike = median > 0 && rates.some((r) => Math.abs(r) > 5 * median);
  if (avg > 0.00005 && negFrac < 0.2 && !hasSpike) return "green";
  return "amber";
}

async function buildFundingTop(): Promise<CachedFundingItem[]> {
  type UniverseItem = { name: string };
  type AssetCtxItem = { funding: string; dayNtlVlm: string; premium: string };
  const [meta, ctxs] = await hlPost<[{ universe: UniverseItem[] }, AssetCtxItem[]]>({
    type: "metaAndAssetCtxs",
  });

  const allPairs = meta.universe
    .map((u, i) => ({ name: u.name, ctx: ctxs[i] }))
    .filter((p) => p.ctx);

  const byVolume = [...allPairs].sort((a, b) => parseFloat(b.ctx.dayNtlVlm) - parseFloat(a.ctx.dayNtlVlm));
  const pairs = byVolume.slice(0, 25);

  // Always include HYPE even if it falls outside the top 25 by volume
  const ALWAYS_INCLUDE = ["HYPE"];
  for (const must of ALWAYS_INCLUDE) {
    if (!pairs.find((p) => p.name === must)) {
      const extra = allPairs.find((p) => p.name === must);
      if (extra) pairs.push(extra);
    }
  }

  const settled = await Promise.allSettled(
    pairs.map(async ({ name, ctx }): Promise<CachedFundingItem> => {
      const currentRate = parseFloat(ctx.funding);
      const premium = parseFloat(ctx.premium);
      const predictedNextRate = Math.min(0.0005, Math.max(-0.0005, premium)) + 0.0001;
      const annualizedRate = Math.pow(1 + currentRate, 8760) - 1;

      const { rates } = await getCoinHistory(name).catch(() => ({ rates: [] as number[], times: [] as number[] }));
      const last24h = rates.slice(-24);
      const avgRate24h =
        last24h.length > 0 ? last24h.reduce((s, r) => s + r, 0) / last24h.length : currentRate;

      return {
        coin: name,
        currentRate,
        annualizedRate,
        predictedNextRate,
        avgRate24h,
        attractiveness: computeAttractiveness(rates),
        volume24h: parseFloat(ctx.dayNtlVlm),
      };
    }),
  );

  return settled
    .filter((r): r is PromiseFulfilledResult<CachedFundingItem> => r.status === "fulfilled")
    .map((r) => r.value);
}

// ─────────────────────────────────────────────────────────────────────────────

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
  laneManager?: BotManager,
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
      coin:              config.exchange.coin,
      network:           config.exchange.network,
      registry:          STRATEGY_REGISTRY,
      defaultStopLoss:   config.risk.stopLossPercent,
    });
  });

  router.post("/api/backtest/run", async (req, res) => {
    try {
      const {
        strategyId,
        coin,
        interval   = "1h",
        candles:   candleLimit = 1000,
        strategyParams = {},
        initialEquity  = 1000,
        commissionPct  = 0.045,   // received as % (e.g. 0.045), stored in runConfig as-is
        stopLossPct    = config.risk.stopLossPercent,
      } = req.body as {
        strategyId:      string;
        coin:            string;
        interval?:       string;
        candles?:        number;
        strategyParams?: Record<string, number>;
        initialEquity?:  number;
        commissionPct?:  number;
        stopLossPct?:    number;
      };

      if (!strategyId || !coin) {
        res.status(400).json({ error: "strategyId and coin are required" });
        return;
      }

      const entry = STRATEGY_REGISTRY.find(
        (e) => e.id === strategyId && e.isCandleStrategy && e.factory !== null,
      );
      if (!entry || !entry.factory) {
        res.status(400).json({ error: `Unknown candle strategy: ${strategyId}` });
        return;
      }

      const limit   = Math.min(parseInt(String(candleLimit)) || 1000, 2000);
      const candles = await fetchCandles(coin.toUpperCase(), interval, limit);
      if (candles.length === 0) {
        res.status(400).json({ error: "No candle data returned for this coin/interval" });
        return;
      }

      // Instantiate strategy; inject user params via Object.assign — TypeScript `private`
      // compiles to regular JS properties, so this correctly overrides defaults at runtime.
      const strategy = entry.factory();
      if (Object.keys(strategyParams).length > 0) Object.assign(strategy, strategyParams);

      // Merge defaults with user params so runConfig shows the full picture
      const paramDefaults = Object.fromEntries(entry.params.map((p) => [p.key, p.default]));
      const mergedParams  = { ...paramDefaults, ...strategyParams };

      const result = runBacktest(strategy, candles, {
        initialEquity,
        positionSizeUsd: config.risk.maxPositionSizeUsd,
        stopLossPct,
        commissionPct: commissionPct / 100,   // convert % → fraction for engine
      });

      res.json({
        ...result,
        returnPct: initialEquity > 0 ? (result.totalPnl / initialEquity) * 100 : 0,
        runConfig: {
          strategyId,
          strategyName:   entry.displayName,
          coin:           coin.toUpperCase(),
          interval,
          fetchedCandles: candles.length,
          strategyParams: mergedParams,
          initialEquity,
          commissionPct,
          stopLossPct,
        },
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[backtest/run]", error.message);
      res.status(500).json({ error: error.message });
    }
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
      botsFile:  laneManager?.getBotsFile() ?? { bots: [], fundingActive: false },
    });
  });

  // ── Bot API ───────────────────────────────────────────────────────────────

  router.get("/api/bots", (_req, res) => {
    const raw = laneManager?.getBotStates() ?? [];
    // Enrich each state with the live funding rate for its coin (from the shared cache)
    const enriched = raw.map((b) => {
      const cached = fundingTopCache?.items.find((i) => i.coin === b.coin);
      return { ...b, fundingRate: cached?.currentRate ?? null };
    });
    res.json(enriched);
  });

  router.post("/api/bots/:id/pause", async (req, res) => {
    if (!laneManager) { res.status(503).json({ error: "Bot manager not initialised" }); return; }
    try {
      await laneManager.pauseBot(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/bots/:id/resume", async (req, res) => {
    if (!laneManager) { res.status(503).json({ error: "Bot manager not initialised" }); return; }
    try {
      await laneManager.resumeBot(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/api/bots/:id", async (req, res) => {
    if (!laneManager) { res.status(503).json({ error: "Bot manager not initialised" }); return; }
    try {
      await laneManager.deleteBot(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/bots", async (req, res) => {
    if (!laneManager) { res.status(503).json({ error: "Bot manager not initialised" }); return; }
    try {
      const { strategyId, coin, timeframe, live, startingEquity } = req.body as {
        strategyId: string; coin: string; timeframe: string;
        live?: boolean; startingEquity?: number;
      };
      if (!strategyId || !coin || !timeframe) {
        res.status(400).json({ error: "strategyId, coin, and timeframe are required" });
        return;
      }
      const id = await laneManager.addBot({ strategyId, coin, timeframe, live, startingEquity });
      res.status(201).json({ ok: true, id });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      res.status(400).json({ error: error.message });
    }
  });

  router.post("/api/bots/config", async (req, res) => {
    if (!laneManager) {
      res.status(503).json({ error: "Bot manager not initialised" });
      return;
    }
    try {
      const body = req.body as BotsFile;
      if (!Array.isArray(body?.bots)) {
        res.status(400).json({ error: "bots array required" });
        return;
      }
      await laneManager.applyConfig(body);
      res.json({ ok: true });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      res.status(400).json({ error: error.message });
    }
  });

  // ── Funding dashboard API ────────────────────────────────────────────────

  router.get("/api/funding/top", async (_req, res) => {
    try {
      const now = Date.now();
      if (!fundingTopCache || fundingTopCache.expiresAt <= now) {
        fundingTopCache = { items: await buildFundingTop(), expiresAt: now + 30_000 };
      }
      // nextFundingMs computed fresh per response so countdown is always accurate
      const nextFundingMs = Math.ceil((now + 1000) / 3_600_000) * 3_600_000 - now;
      res.json(
        fundingTopCache.items.map((item) => ({
          ...item,
          nextFundingMs,
          displayName: coinDisplayName(item.coin),
        })),
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[funding/top]", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/api/funding/history/:coin", async (req, res) => {
    try {
      const coin = req.params.coin.toUpperCase();
      res.json(await getCoinHistory(coin));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/bots", (_req, res) => {
    res.render("bots", {
      network:  config.exchange.network,
      coin:     config.exchange.coin,
      registry: STRATEGY_REGISTRY,
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
