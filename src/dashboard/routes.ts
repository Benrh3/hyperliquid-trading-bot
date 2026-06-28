import { Router } from "express";
import { join } from "path";
import { RSI } from "technicalindicators";
import { config, coins, API_URL } from "../config.js";
import { runBacktest, fetchCandles, fetchCandlesByRange, runFundingBasisBacktest, fetchFundingHistory, attachSignals, BACKTEST_INTERVAL_MS } from "../backtest.js";
import { alignFundingRows } from "../chart-utils.js";
import { makeCacheKey, isValidCoin, isValidInterval } from "../candle-cache-utils.js";
import { InfoClient, HttpTransport } from "@nktkas/hyperliquid";
import { CANDLE_STRATEGIES, STRATEGY_REGISTRY } from "../strategy/registry.js";
import { INDICATOR_REGISTRY } from "../strategy/indicators.js";
import { saveCustomDef, deleteCustomDef, customDefToRegistryEntry } from "../strategy/custom-strategy.js";
import type { CustomStrategyDef } from "../strategy/custom-strategy.js";
import type { Logger } from "../logger.js";
import type { BotState } from "./server.js";
import type { Strategy } from "../strategy/base.js";
import type { Feed } from "../feed.js";
import type { Executor } from "../executor.js";
import type { BotManager, BotsFile, OrphanedPosition } from "../bot-manager.js";
import type { DydxFundingPoller } from "../dydx-funding.js";
import type { FundingMatrixPoller } from "../funding-matrix.js";
import type { MarketStore } from "../market/store.js";
import { createMarketRouter } from "../market/api.js";

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
      const annualizedRate = currentRate * 8760;

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

// ── Walk-forward grid helpers ─────────────────────────────────────────────────

function generateParamGrid(
  params: { key: string; min: number; max: number; step: number }[],
  maxCombinations = 200,
): Record<string, number>[] {
  if (params.length === 0) return [{}];

  let combos: Record<string, number>[] = [{}];
  for (const p of params) {
    const vals: number[] = [];
    for (let v = p.min; v <= p.max + 1e-9; v += p.step) {
      vals.push(Math.round(v * 1000) / 1000);
    }
    const next: Record<string, number>[] = [];
    for (const combo of combos) {
      for (const v of vals) next.push({ ...combo, [p.key]: v });
    }
    combos = next;
    if (combos.length > 50_000) { combos = combos.slice(0, 50_000); break; }
  }

  if (combos.length > maxCombinations) {
    const step = Math.ceil(combos.length / maxCombinations);
    return combos.filter((_, i) => i % step === 0).slice(0, maxCombinations);
  }
  return combos;
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
  dydxPoller?: DydxFundingPoller,
  fundingMatrix?: FundingMatrixPoller,
  marketStore?: MarketStore,
): Router {
  const router = Router();

  // ── Shared locals for _nav.ejs ──────────────────────────────────────────
  router.use((req, res, next) => {
    res.locals.currentPath = req.path;
    res.locals.pillar = req.path.startsWith("/market") ? "market" : "bot";
    res.locals.network = res.locals.network ?? config.exchange.network;
    next();
  });

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

  router.get("/market", (_req, res) => {
    res.render("market", {
      title:   "HYPE Market",
      network: config.exchange.network,
    });
  });

  router.get("/trades", (_req, res) => {
    const { trades, total } = logger.getFilteredTrades({ limit: 200 });
    const stats   = logger.getTradeStats();
    const options = logger.getTradeFilterOptions();
    res.render("trades", { trades, total, stats, options });
  });

  router.get("/api/trades", (req, res) => {
    const limit  = Math.min(parseInt(typeof req.query.limit  === "string" ? req.query.limit  : "200") || 200, 500);
    const offset = parseInt(typeof req.query.offset === "string" ? req.query.offset : "0") || 0;
    const botId    = typeof req.query.botId    === "string" ? req.query.botId    : undefined;
    const strategy = typeof req.query.strategy === "string" ? req.query.strategy : undefined;
    const coin     = typeof req.query.coin     === "string" ? req.query.coin     : undefined;
    const success  = typeof req.query.success  === "string" ? parseInt(req.query.success) : undefined;

    const { trades, total } = logger.getFilteredTrades({ botId, strategy, coin, success, limit, offset });
    const stats   = logger.getTradeStats({ botId, strategy, coin });
    const options = logger.getTradeFilterOptions();
    res.json({ trades, total, stats, options, hasMore: offset + trades.length < total });
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
        rangeDays,
        strategyParams = {},
        initialEquity  = 1000,
        commissionPct  = 0.05,    // received as % (e.g. 0.05 = 0.05%/side), matches live TAKER_FEE_PER_SIDE
        stopLossPct    = config.risk.stopLossPercent,
      } = req.body as {
        strategyId:      string;
        coin:            string;
        interval?:       string;
        candles?:        number;
        rangeDays?:      number;
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

      let candles: Awaited<ReturnType<typeof fetchCandles>>;
      if (rangeDays && rangeDays > 0) {
        const endTime   = Date.now();
        const startTime = endTime - rangeDays * 86_400_000;
        candles = await fetchCandlesByRange(coin.toUpperCase(), interval, startTime, endTime);
      } else {
        const limit = Math.min(parseInt(String(candleLimit)) || 1000, 5000);
        candles = await fetchCandles(coin.toUpperCase(), interval, limit);
      }
      if (candles.length === 0) {
        res.status(400).json({ error: "No candle data returned for this coin/interval" });
        return;
      }

      // Attach Market signal data to candles (backtest-only; no strategy reads these yet)
      let signalCoverage: { key: string; filled: number; total: number }[] = [];
      if (marketStore && coin.toUpperCase() === "HYPE") {
        const BACKTEST_SIGNALS = ["lsr_agg_long_frac", "funding_rate", "book_imbalance"];
        const signalMap = new Map<string, Array<{ capturedAt: number; value: number | null }>>();
        for (const key of BACKTEST_SIGNALS) {
          const series = marketStore.getMetricTimeSeries("HYPE", key);
          if (series.length > 0) signalMap.set(key, series);
        }
        signalCoverage = attachSignals(candles, signalMap);
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
        positionSizeUsd: Math.round(initialEquity * (config.risk.riskPerTradePercent / config.risk.stopLossPercent)),
        stopLossPct,
        commissionPct: commissionPct / 100,   // convert % → fraction for engine
      });

      res.json({
        ...result,
        returnPct: initialEquity > 0 ? (result.totalPnl / initialEquity) * 100 : 0,
        signalCoverage,
        runConfig: {
          strategyId,
          strategyName:   entry.displayName,
          coin:           coin.toUpperCase(),
          interval,
          fetchedCandles: candles.length,
          rangeStart:     candles.length > 0 ? new Date(candles[0].timestamp).toISOString() : null,
          rangeEnd:       candles.length > 0 ? new Date(candles[candles.length - 1].timestamp).toISOString() : null,
          rangeDays:      candles.length > 1 ? Math.round((candles[candles.length - 1].timestamp - candles[0].timestamp) / 86_400_000) : 0,
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
      network:    config.exchange.network,
      coin:       config.exchange.coin,
      registry:   STRATEGY_REGISTRY,
      indicators: INDICATOR_REGISTRY,
    });
  });

  router.get("/settings", (_req, res) => {
    const hlKey         = process.env.HL_PRIVATE_KEY ?? "";
    const hlMainnetKey  = process.env.HL_MAINNET_PRIVATE_KEY ?? "";
    const maskKey = (k: string) => k.length > 10
      ? `${k.slice(0, 6)}…${k.slice(-4)}`
      : k ? "***" : "";
    res.render("settings", {
      network:             config.exchange.network,
      coin:                config.exchange.coin,
      risk:                config.risk,
      hlKeyLoaded:         hlKey.length > 0,
      hlKeyMasked:         maskKey(hlKey),
      hlMainnetKeyLoaded:  hlMainnetKey.length > 0,
      hlMainnetKeyMasked:  maskKey(hlMainnetKey),
      dydxMnemonicLoaded:  !!(process.env.DYDX_TESTNET_MNEMONIC?.trim()),
    });
  });

  // ── Bot API ───────────────────────────────────────────────────────────────

  router.get("/api/bots", (_req, res) => {
    const raw = laneManager?.getBotStates() ?? [];
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
      const body = req.body as { bots?: BotsFile["bots"] };
      if (!Array.isArray(body?.bots)) {
        res.status(400).json({ error: "bots array required" });
        return;
      }
      // Merge-only: keep bots added after the page loaded
      const currentBots  = laneManager.getBotsFile().bots;
      const submittedIds = new Set(body.bots.map((b) => b.id));
      const unseen       = currentBots.filter((b) => !submittedIds.has(b.id));
      await laneManager.applyConfig({ bots: [...body.bots, ...unseen] });
      res.json({ ok: true });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      res.status(400).json({ error: error.message });
    }
  });

  // ── Orphaned positions (on exchange but not claimed by any live bot) ──────

  router.get("/api/orphans", (_req, res) => {
    const orphans: OrphanedPosition[] = laneManager?.getOrphanedPositions() ?? [];
    res.json(orphans);
  });

  router.post("/api/orphans/:coin/close", async (req, res) => {
    if (!laneManager) { res.status(503).json({ error: "Bot manager not initialised" }); return; }
    try {
      await laneManager.closeOrphan(req.params.coin.toUpperCase());
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Toggle execution mode for a cross-venue bot (paper ↔ live)
  router.post("/api/bots/:id/mode", (req, res) => {
    if (!laneManager) { res.status(503).json({ error: "Bot manager not initialised" }); return; }
    const { mode } = req.body as { mode?: string };
    if (mode !== "paper" && mode !== "live") {
      res.status(400).json({ error: 'mode must be "paper" or "live"' });
      return;
    }
    try {
      laneManager.setBotMode(req.params.id, mode);
      res.json({ ok: true, mode });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
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

  // ── Market data API (stage 6: scoring, scorecard, bias, signals CSV) ────────
  if (marketStore) {
    router.use(createMarketRouter(marketStore));
  }

  // ── Market data snapshots (observe-only, read-only) ──────────────────────

  router.get("/api/snapshots", (req, res) => {
    if (!marketStore) {
      res.status(503).json({ error: "Market store not available" });
      return;
    }
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "HYPE";
    const limit  = Math.min(parseInt(typeof req.query.limit === "string" ? req.query.limit : "50") || 50, 500);
    res.json(marketStore.getRecentSnapshots(symbol, limit));
  });

  router.get("/bots", (_req, res) => {
    res.render("bots", {
      network:  config.exchange.network,
      coin:     config.exchange.coin,
      registry: STRATEGY_REGISTRY,
    });
  });

  router.get("/builder", (_req, res) => {
    res.render("builder", {
      network:    config.exchange.network,
      coin:       config.exchange.coin,
      registry:   STRATEGY_REGISTRY,
      indicators: INDICATOR_REGISTRY.map(m => ({
        id:           m.id,
        displayName:  m.displayName,
        category:     m.category,
        outputType:   m.outputType,
        outputKeys:   m.outputKeys,
        defaultParams: m.defaultParams,
      })),
    });
  });

  // ── Custom strategy API ───────────────────────────────────────────────────

  router.post("/api/strategies/custom", (req, res) => {
    try {
      const def = req.body as CustomStrategyDef;
      if (!def.id || !def.name) {
        res.status(400).json({ error: "id and name are required" });
        return;
      }
      // Ensure required fields have defaults
      def.isCustom        = true;
      def.entryLongRules  = def.entryLongRules  ?? [];
      def.entryShortRules = def.entryShortRules ?? [];
      def.exitRules       = def.exitRules        ?? [];
      def.entryLogic      = def.entryLogic       ?? "AND";
      def.exitLogic       = def.exitLogic        ?? "AND";
      def.stopLoss        = def.stopLoss         ?? 2;
      def.takeProfit      = def.takeProfit        ?? 0;

      saveCustomDef(def);

      // Register in the live registry so it appears immediately without restart
      const existing = STRATEGY_REGISTRY.findIndex(e => e.id === def.id);
      const entry    = customDefToRegistryEntry(def);
      if (existing >= 0) STRATEGY_REGISTRY[existing] = entry;
      else               STRATEGY_REGISTRY.push(entry);

      res.json({ ok: true, id: def.id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/api/strategies/custom/:id", (req, res) => {
    try {
      deleteCustomDef(req.params.id);
      const idx = STRATEGY_REGISTRY.findIndex(e => e.id === req.params.id && e.isCustom);
      if (idx >= 0) STRATEGY_REGISTRY.splice(idx, 1);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
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

  // ── On-demand candle endpoint (any perpetual coin, with short-TTL cache) ─────
  //
  // Unlike /api/candles (which reads the in-memory feed for configured coins),
  // this endpoint fetches from Hyperliquid on-demand for ANY coin in the
  // perpetuals universe and caches results for CANDLE_CACHE_TTL_MS to avoid
  // burst rate-limiting when the user switches coins rapidly.

  const CANDLE_CACHE_TTL_MS = 15_000; // 15 s

  interface DynCandleCache {
    data: ReturnType<typeof buildCandleResponse>;
    expiresAt: number;
  }
  const dynCandleCache = new Map<string, DynCandleCache>();

  // Hyperliquid universe cache (5 min) — avoids meta() round-trip on every request
  let hlUniverseCache: { names: string[]; expiresAt: number } | null = null;
  async function getHlUniverse(): Promise<string[]> {
    const now = Date.now();
    if (hlUniverseCache && hlUniverseCache.expiresAt > now) return hlUniverseCache.names;
    const isTestnet = config.exchange.network === "testnet";
    const infoClient = new InfoClient({ transport: new HttpTransport({ isTestnet }) });
    const { universe } = await infoClient.meta();
    hlUniverseCache = { names: universe.map((u) => u.name.toUpperCase()), expiresAt: now + 5 * 60_000 };
    return hlUniverseCache.names;
  }

  function buildCandleResponse(
    candleRaw: Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>,
    coinParam:  string,
    spreadHist: Array<{ t: number; value: number }>,
    evts:       Array<{ module: string; level: string; data: string | null }>,
  ) {
    const candleData = candleRaw.map((c) => ({
      time:  Math.floor(c.t / 1000),
      open:  parseFloat(c.o),
      high:  parseFloat(c.h),
      low:   parseFloat(c.l),
      close: parseFloat(c.c),
    }));
    const volumeData = candleRaw.map((c) => ({
      time:  Math.floor(c.t / 1000),
      value: parseFloat(c.v),
      color: parseFloat(c.c) >= parseFloat(c.o) ? "rgba(63,185,80,0.5)" : "rgba(248,81,73,0.5)",
    }));
    const closes    = candleRaw.map((c) => parseFloat(c.c));
    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    const rsiData   = rsiValues.map((value, i) => ({
      time:  Math.floor(candleRaw[i + 14].t / 1000),
      value,
    }));
    const spreadData = spreadHist.map((s) => ({ time: Math.floor(s.t / 1000), value: s.value }));
    const candleTimes = candleData.map((c) => c.time);
    function snapToCandle(secs: number) {
      let best = candleTimes[0];
      for (const t of candleTimes) { if (t <= secs) best = t; else break; }
      return best;
    }
    const markers = evts
      .filter((e) => e.module === "strategy" && e.level === "info" && e.data)
      .flatMap((e) => {
        try {
          const sig = JSON.parse(e.data as string) as { side: string; timestamp: number };
          const timeSecs = snapToCandle(Math.floor(sig.timestamp / 1000));
          return [{ time: timeSecs, position: sig.side === "long" ? "belowBar" : "aboveBar",
            color: sig.side === "long" ? "#3fb950" : "#f85149",
            shape: sig.side === "long" ? "arrowUp" : "arrowDown",
            text:  sig.side === "long" ? "L" : "S" }];
        } catch { return []; }
      })
      .sort((a, b) => (a.time as number) - (b.time as number));
    return { candles: candleData, volume: volumeData, rsi: rsiData, markers, spread: spreadData };
  }

  router.get("/api/candles/dynamic", async (req, res) => {
    const coin     = typeof req.query.coin     === "string" ? req.query.coin.toUpperCase().trim() : "";
    const interval = typeof req.query.interval === "string" ? req.query.interval : "1h";

    if (!coin)                    { res.status(400).json({ error: "coin param required" });              return; }
    if (!isValidInterval(interval)) { res.status(400).json({ error: `Unknown interval: ${interval}` }); return; }

    // Validate coin against live Hyperliquid universe
    let universe: string[];
    try { universe = await getHlUniverse(); }
    catch { universe = []; } // if meta() fails, skip validation and attempt fetch anyway

    if (universe.length > 0 && !isValidCoin(coin, universe)) {
      res.status(404).json({ error: `"${coin}" is not listed on Hyperliquid perpetuals` });
      return;
    }

    // Serve from cache if fresh
    const cacheKey = makeCacheKey(coin, interval);
    const cached = dynCandleCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json(cached.data);
      return;
    }

    // Fetch from Hyperliquid
    try {
      const isTestnet  = config.exchange.network === "testnet";
      const infoClient = new InfoClient({ transport: new HttpTransport({ isTestnet }) });
      const now        = Date.now();
      const tfMs: Record<string, number> = {
        "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
        "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000,
        "12h": 43_200_000, "1d": 86_400_000,
      };
      const startTime  = now - 500 * (tfMs[interval] ?? 3_600_000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await infoClient.candleSnapshot({ coin, interval: interval as any, startTime, endTime: now });

      if (!raw || raw.length === 0) {
        res.status(404).json({ error: `No candle data available for ${coin}/${interval}` });
        return;
      }

      const spread = state.spreadHistory[coin] ?? [];
      const events = logger.getEventLog(500);
      const data   = buildCandleResponse(raw, coin, spread, events);

      dynCandleCache.set(cacheKey, { data, expiresAt: Date.now() + CANDLE_CACHE_TTL_MS });
      res.json(data);
    } catch (e) {
      res.status(502).json({ error: `Failed to fetch candles: ${(e as Error).message}` });
    }
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

  router.get("/api/portfolio-risk", (_req, res) => {
    const stopFrac = config.risk.stopLossPercent / 100;
    const bots     = laneManager?.getBotStates() ?? [];
    // Sum dollar-at-risk for every live bot with an open position
    let openRiskUsd = 0;
    for (const b of bots) {
      if (!b.live || !b.position || b.position.side === "neutral") continue;
      openRiskUsd += b.position.size * b.position.entryPrice * stopFrac;
    }
    // Use the first live bot's equity as a proxy for account equity (best we can do client-side)
    const liveEquity = bots.find((b) => b.live)?.equity ?? 1_000;
    const openRiskPct = liveEquity > 0 ? (openRiskUsd / liveEquity) * 100 : 0;
    res.json({
      openRiskUsd:          parseFloat(openRiskUsd.toFixed(4)),
      openRiskPct:          parseFloat(openRiskPct.toFixed(2)),
      maxConcurrentRiskPct: config.risk.maxConcurrentRiskPercent,
      riskPerTradePct:      config.risk.riskPerTradePercent,
      stopLossPct:          config.risk.stopLossPercent,
      maxLeverage:          config.risk.maxLeverage,
    });
  });

  router.get("/api/dydx-funding", (_req, res) => {
    res.json(dydxPoller?.getState() ?? { rate: null, lastUpdated: null, error: "Poller not initialised" });
  });

  // dYdX perpetuals universe — used by the +Add Bot coin dropdown intersection filter.
  // Cached for 5 minutes since the list changes rarely.
  let dydxMarketsCache: { coins: string[]; expiresAt: number } | null = null;
  router.get("/api/dydx-markets", async (_req, res) => {
    try {
      const now = Date.now();
      if (!dydxMarketsCache || dydxMarketsCache.expiresAt <= now) {
        type MktResp = { markets?: Record<string, unknown> };
        const r = await fetch("https://indexer.v4testnet.dydx.exchange/v4/perpetualMarkets", {
          headers: { Accept: "application/json" },
          signal:  AbortSignal.timeout(8_000),
        });
        if (!r.ok) throw new Error(`dYdX HTTP ${r.status}`);
        const data = await r.json() as MktResp;
        const coins = Object.keys(data.markets ?? {})
          // Normalise "BTC-USD" → "BTC" so comparisons with HL universe are trivial
          .map((t) => t.replace(/-USD$/, ""))
          .filter(Boolean)
          .sort();
        dydxMarketsCache = { coins, expiresAt: now + 5 * 60_000 };
      }
      res.json(dydxMarketsCache.coins);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/safety-status", async (_req, res) => {
    const { execSync } = await import("child_process");
    const { existsSync } = await import("fs");
    const checks: Array<{ name: string; status: "pass" | "fail" | "warn"; detail: string }> = [];

    // (a) .env exists and is NOT tracked by git
    const envPath = join(process.cwd(), ".env");
    const envExists = existsSync(envPath);
    let envNotTracked = false;
    try { envNotTracked = execSync("git ls-files .env", { encoding: "utf-8" }).trim() === ""; } catch { /* ok */ }
    checks.push({
      name:   ".env file exists and is gitignored",
      status: envExists && envNotTracked ? "pass" : "fail",
      detail: !envExists ? ".env file missing" : !envNotTracked ? ".env is tracked by git — DANGER" : "OK",
    });

    // (b) HL_MAINNET_PRIVATE_KEY is set and distinct from HL_PRIVATE_KEY
    const mainKey = process.env.HL_MAINNET_PRIVATE_KEY;
    const testKey = process.env.HL_PRIVATE_KEY;
    const mainKeyOk = !!mainKey && mainKey !== testKey && /^0x[0-9a-fA-F]{64}$/.test(mainKey);
    checks.push({
      name:   "Mainnet private key set and distinct from testnet key",
      status: mainKeyOk ? "pass" : "fail",
      detail: !mainKey ? "HL_MAINNET_PRIVATE_KEY not set" : mainKey === testKey ? "Keys are identical!" : !mainKeyOk ? "Invalid format" : "OK",
    });

    // (c) npm audit — no critical/high
    let auditStatus: "pass" | "fail" | "warn" = "warn";
    let auditDetail = "Could not run npm audit";
    try {
      execSync("npm audit --audit-level=high --json", { encoding: "utf-8" });
      auditStatus = "pass"; auditDetail = "No critical/high vulnerabilities";
    } catch (e: unknown) {
      const stdout = (e as { stdout?: string }).stdout ?? "";
      try {
        const r = JSON.parse(stdout) as { metadata?: { vulnerabilities?: { critical: number; high: number } } };
        const v = r.metadata?.vulnerabilities;
        if (v && (v.critical > 0 || v.high > 0)) {
          auditStatus = "fail"; auditDetail = `${v.critical} critical, ${v.high} high`;
        } else { auditStatus = "pass"; auditDetail = "No critical/high vulnerabilities"; }
      } catch { /* leave warn */ }
    }
    checks.push({ name: "No critical/high npm vulnerabilities", status: auditStatus, detail: auditDetail });

    // (d) position sizing uses percentage-based risk (not the deprecated fixed-dollar field)
    const riskPct = config.risk?.riskPerTradePercent;
    checks.push({
      name:   "Percentage-based position sizing configured",
      status: riskPct > 0 && riskPct <= 5 ? "pass" : "warn",
      detail: !riskPct ? "riskPerTradePercent not set" : riskPct > 5 ? `riskPerTradePercent=${riskPct}% is high for mainnet — consider ≤2%` : `${riskPct}% per trade`,
    });

    // (e) emergency-stop endpoint (not yet implemented)
    checks.push({
      name:   "Emergency-stop endpoint implemented",
      status: "fail",
      detail: "POST /api/emergency-stop not yet implemented",
    });

    res.json({
      allPass: checks.every((c) => c.status === "pass"),
      checks,
    });
  });

  router.get("/api/prices", (_req, res) => {
    res.json(state.lastPrices);
  });

  // ── Walk-forward backtesting ──────────────────────────────────────────────

  router.post("/api/backtest/walkforward", async (req, res) => {
    // Walk-forward grid-searches many param combos × expanding windows;
    // can take 30–120s for strategies with params. Extend the timeout
    // so nginx/Express don't kill the request.
    req.setTimeout(300_000);
    res.setTimeout(300_000);
    try {
      const {
        strategyId,
        coin,
        interval    = "1h",
        totalCandles = 2000,
        rangeDays,
        windows      = 5,
        optimiseBy   = "sharpeRatio",
        commissionPct = 0.05,     // 0.05%/side, matches live TAKER_FEE_PER_SIDE
        stopLossPct   = config.risk.stopLossPercent,
        initialEquity = 1000,
      } = req.body as {
        strategyId:     string;
        coin:           string;
        interval?:      string;
        totalCandles?:  number;
        rangeDays?:     number;
        windows?:       number;
        optimiseBy?:    string;
        commissionPct?: number;
        stopLossPct?:   number;
        initialEquity?: number;
      };

      const entry = STRATEGY_REGISTRY.find(e => e.id === strategyId && e.isCandleStrategy && e.factory);
      if (!entry?.factory) { res.status(400).json({ error: `Unknown strategy: ${strategyId}` }); return; }

      let allCandles: Awaited<ReturnType<typeof fetchCandles>>;
      if (rangeDays && rangeDays > 0) {
        const endTime   = Date.now();
        const startTime = endTime - rangeDays * 86_400_000;
        allCandles = await fetchCandlesByRange(coin.toUpperCase(), interval, startTime, endTime);
      } else {
        const limit = Math.min(parseInt(String(totalCandles)) || 2000, 5000);
        allCandles = await fetchCandles(coin.toUpperCase(), interval, limit);
      }
      if (allCandles.length < windows * 10) {
        res.status(400).json({ error: "Not enough candles for the requested number of windows" });
        return;
      }

      const nWin      = Math.min(Math.max(parseInt(String(windows)) || 5, 2), 10);
      const segSize   = Math.floor(allCandles.length / nWin);
      const btOpts    = { initialEquity, positionSizeUsd: Math.round(initialEquity * (config.risk.riskPerTradePercent / config.risk.stopLossPercent)), stopLossPct, commissionPct: commissionPct / 100 };
      const grid      = generateParamGrid(entry.params, 50);

      const windowResults: object[] = [];
      const stitchedEquity: { time: number; equity: number }[] = [];
      let prevEndEquity = initialEquity;

      // Warmup bars prepended to OOS so indicator buffers are primed.
      // Without this, strategies with large MIN_CANDLES (e.g. TrendFollow=201)
      // produce zero trades on short OOS segments.
      const WARMUP_BARS = 250;

      for (let i = 1; i < nWin; i++) {
        const isSamples  = allCandles.slice(0, i * segSize);
        const oosStart   = i * segSize;
        const oosEnd     = (i + 1) * segSize;
        const rawOos     = allCandles.slice(oosStart, oosEnd);
        if (rawOos.length === 0) break;

        // Prepend warmup from IS tail so indicators are primed for OOS
        const warmupStart = Math.max(0, oosStart - WARMUP_BARS);
        const warmup      = allCandles.slice(warmupStart, oosStart);
        const oosSamples  = [...warmup, ...rawOos];
        const warmupLen   = warmup.length;

        // Grid-search on IS window
        let bestParams: Record<string, number> = grid[0] ?? {};
        let bestMetric = -Infinity;
        let bestISResult: ReturnType<typeof runBacktest> | null = null;

        for (const params of grid) {
          const s = entry.factory!();
          if (Object.keys(params).length > 0) Object.assign(s, params);
          const r = runBacktest(s, isSamples, btOpts);
          const m = (r as unknown as Record<string, number>)[optimiseBy] ?? 0;
          if (m > bestMetric) { bestMetric = m; bestParams = params; bestISResult = r; }
        }

        // OOS with best params (warmup-prefixed so indicators are hot)
        const oosStrat = entry.factory!();
        if (Object.keys(bestParams).length > 0) Object.assign(oosStrat, bestParams);
        const fullOosResult = runBacktest(oosStrat, oosSamples, btOpts);

        // Extract OOS-only metrics: trades and equity from after the warmup period
        const oosOnlyTrades = fullOosResult.trades.filter(t => t.entryTime >= rawOos[0].timestamp);
        const oosOnlyPnl    = oosOnlyTrades.reduce((s, t) => s + t.pnl, 0);
        const oosResult = {
          ...fullOosResult,
          totalPnl:    oosOnlyPnl,
          tradeCount:  oosOnlyTrades.length,
          trades:      oosOnlyTrades,
          equityCurve: fullOosResult.equityCurve.filter(p => p.time >= rawOos[0].timestamp),
          // Recompute win rate and Sharpe on OOS-only trades
          winRate:     oosOnlyTrades.length > 0 ? oosOnlyTrades.filter(t => t.pnl > 0).length / oosOnlyTrades.length : 0,
          sharpeRatio: computeOosSharpe(oosOnlyTrades),
        };

        function computeOosSharpe(trades: typeof oosOnlyTrades): number {
          if (trades.length < 2) return 0;
          const returns = trades.map(t => t.pnl / (t.entryPrice * t.size));
          const mean    = returns.reduce((s, r) => s + r, 0) / returns.length;
          const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
          const std     = Math.sqrt(variance);
          return std > 1e-10 ? (mean / std) * Math.sqrt(returns.length) : 0;
        }
        const oosReturn = initialEquity > 0 ? (oosResult.totalPnl / initialEquity) * 100 : 0;
        const isReturn  = initialEquity > 0 && bestISResult ? (bestISResult.totalPnl / initialEquity) * 100 : 0;

        // Stitch OOS equity curve (continuous from previous window end)
        const stitched = oosResult.equityCurve.map(p => ({
          time:   p.time,
          equity: prevEndEquity + (p.equity - initialEquity),
        }));
        if (stitched.length > 0) {
          stitchedEquity.push(...stitched);
          prevEndEquity = stitched[stitched.length - 1].equity;
        }

        // B&H for this OOS segment (rawOos = actual OOS without warmup)
        const bhOos = rawOos.length > 1
          ? (rawOos[rawOos.length - 1].close - rawOos[0].close) / rawOos[0].close * 100
          : 0;

        windowResults.push({
          window:     i,
          isStart:    isSamples[0]?.timestamp,
          isEnd:      isSamples[isSamples.length - 1]?.timestamp,
          isCandles:  isSamples.length,
          oosStart:   rawOos[0]?.timestamp,
          oosEnd:     rawOos[rawOos.length - 1]?.timestamp,
          oosCandles: rawOos.length,
          bestParams,
          isMetrics:  { sharpeRatio: bestISResult?.sharpeRatio ?? 0, returnPct: isReturn, tradeCount: bestISResult?.tradeCount ?? 0 },
          oosMetrics: { sharpeRatio: oosResult.sharpeRatio, returnPct: oosReturn, tradeCount: oosResult.tradeCount },
          bhOosReturnPct: bhOos,
          beatsBH:    oosReturn > bhOos,
        });
      }

      const wr = windowResults as Array<{
        isMetrics: { sharpeRatio: number };
        oosMetrics: { sharpeRatio: number; returnPct: number };
        bhOosReturnPct: number;
        beatsBH: boolean;
      }>;
      const meanIsSharpe  = wr.reduce((s, r) => s + r.isMetrics.sharpeRatio,  0) / wr.length;
      const meanOosSharpe = wr.reduce((s, r) => s + r.oosMetrics.sharpeRatio, 0) / wr.length;
      const pctBeatBH     = wr.filter(r => r.beatsBH).length / wr.length * 100;
      const curveFit      = meanIsSharpe > 0 && meanOosSharpe < meanIsSharpe * 0.5;

      res.json({
        windows: windowResults,
        aggregate: { meanIsSharpe, meanOosSharpe, pctBeatBH, curveFitWarning: curveFit },
        stitchedEquity,
        runConfig: {
          strategyId, strategyName: entry.displayName, coin, interval,
          totalCandles: allCandles.length, windows: nWin, optimiseBy, initialEquity,
          rangeStart: allCandles.length > 0 ? new Date(allCandles[0].timestamp).toISOString() : null,
          rangeEnd:   allCandles.length > 0 ? new Date(allCandles[allCandles.length - 1].timestamp).toISOString() : null,
          rangeDays:  allCandles.length > 1 ? Math.round((allCandles[allCandles.length - 1].timestamp - allCandles[0].timestamp) / 86_400_000) : 0,
        },
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[backtest/walkforward]", error.message);
      res.status(500).json({ error: error.message });
    }
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

      const btInitialEquity = 1000;
      const btOptions = {
        initialEquity:   btInitialEquity,
        positionSizeUsd: Math.round(btInitialEquity * (config.risk.riskPerTradePercent / config.risk.stopLossPercent)),
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

  // ── Funding matrix (all venues × all coins) ──────────────────────────────────

  router.get("/api/funding-matrix", (_req, res) => {
    if (!fundingMatrix) {
      res.status(503).json({ error: "Funding matrix poller not initialised" });
      return;
    }
    res.json(fundingMatrix.getMatrix());
  });

  // ── Equity history ────────────────────────────────────────────────────────────

  router.get("/api/equity-history", (req, res) => {
    const rangeMs = parseRangeParam(req.query["range"] as string | undefined, 24 * 3_600_000);
    res.json(logger.getEquityHistory(rangeMs));
  });

  // ── Funding-rate history for a single coin ────────────────────────────────────

  router.get("/api/funding-history", (req, res) => {
    const coin = (req.query["coin"] as string | undefined)?.toUpperCase();
    if (!coin) { res.status(400).json({ error: "coin query param required" }); return; }
    const rangeMs = parseRangeParam(req.query["range"] as string | undefined, 24 * 3_600_000);
    // Alignment happens server-side using the single tested implementation in
    // chart-utils.ts — the browser receives pre-aligned [{ ts, hl, dydx, spread }]
    // rows and no longer needs its own copy of the join logic.
    const raw     = logger.getFundingHistory(coin, rangeMs);
    res.json(alignFundingRows(raw));
  });

  // ── Per-bot realised + unrealised P&L ────────────────────────────────────────

  router.get("/api/bot-pnl", (_req, res) => {
    const bots = laneManager?.getBotStates() ?? [];
    let totalRealized   = 0;
    let totalUnrealized = 0;
    const botPnl = bots.map((b) => {
      totalRealized   += b.sessionPnl    ?? 0;
      totalUnrealized += b.unrealisedPnl ?? 0;
      return {
        id:            b.id,
        strategyId:    b.strategyId,
        coin:          b.coin,
        timeframe:     b.timeframe,
        status:        b.status,
        realizedPnl:   b.sessionPnl    ?? 0,
        unrealizedPnl: b.unrealisedPnl ?? 0,
        totalPnl:      (b.sessionPnl ?? 0) + (b.unrealisedPnl ?? 0),
        tradeCount:    b.tradeCount,
        equity:        b.equity,
      };
    });
    res.json({
      bots: botPnl,
      totals: {
        realizedPnl:   totalRealized,
        unrealizedPnl: totalUnrealized,
        totalPnl:      totalRealized + totalUnrealized,
      },
    });
  });

  return router;
}

/** Parse a range string like "24h", "7d", "30d" into milliseconds. */
function parseRangeParam(raw: string | undefined, defaultMs: number): number {
  if (!raw) return defaultMs;
  const match = /^(\d+)(h|d|w)$/.exec(raw.trim());
  if (!match) return defaultMs;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "h") return n * 3_600_000;
  if (unit === "d") return n * 86_400_000;
  if (unit === "w") return n * 7 * 86_400_000;
  return defaultMs;
}
