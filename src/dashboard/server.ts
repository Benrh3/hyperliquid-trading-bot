import express from "express";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { bus } from "../events.js";
import { config, coins } from "../config.js";
import type { Candle, OrderbookSnapshot } from "../events.js";
import type { Logger } from "../logger.js";
import type { Strategy } from "../strategy/base.js";
import type { Feed } from "../feed.js";
import type { Executor } from "../executor.js";
import type { BotManager } from "../bot-manager.js";
import type { DydxFundingPoller } from "../dydx-funding.js";
import { createRouter } from "./routes.js";

export interface BotState {
  lastPrices: Record<string, { mid: number; bid: number; ask: number }>;
  lastUpdate: Date | null;
  signalCount: number;
  startedAt: Date;
  candleHistory: Record<string, Candle[]>;
  spreadHistory: Record<string, { t: number; value: number }[]>;
  currentInterval: string;
  equityHistory: { time: number; equity: number }[];
  orderbooks: Record<string, OrderbookSnapshot>;
}

const INITIAL_EQUITY = 1000;
const MAX_EQUITY_HISTORY = 1440; // 24h at 1-minute recording

export function startDashboard(logger: Logger, strategies: Strategy[] = [], feed?: Feed, executor?: Executor, laneManager?: BotManager, dydxPoller?: DydxFundingPoller): void {
  const state: BotState = {
    lastPrices: Object.fromEntries(coins.map((c) => [c, { mid: 0, bid: 0, ask: 0 }])),
    lastUpdate: null,
    signalCount: 0,
    startedAt: new Date(),
    candleHistory: Object.fromEntries(coins.map((c) => [c, []])),
    spreadHistory: Object.fromEntries(coins.map((c) => [c, []])),
    currentInterval: config.strategy.interval,
    equityHistory: [],
    orderbooks: Object.fromEntries(
      coins.map((c) => [c, { coin: c, timestamp: 0, bids: [], asks: [] } satisfies OrderbookSnapshot]),
    ),
  };

  // Track realised PnL locally so equity recording doesn't need a DB query
  let realisedPnl = 0;
  bus.on("trade", (result) => {
    if (result.success && result.pnl != null) {
      realisedPnl += result.pnl;
    }
  });

  // Record equity snapshot every 60 seconds
  setInterval(() => {
    const pos = executor?.getPosition();
    const unrealisedPnl = pos?.unrealisedPnl ?? 0;
    state.equityHistory.push({ time: Date.now(), equity: INITIAL_EQUITY + realisedPnl + unrealisedPnl });
    if (state.equityHistory.length > MAX_EQUITY_HISTORY) state.equityHistory.shift();
  }, 60_000);

  const MAX_CANDLE_HISTORY = 500;
  const MAX_SPREAD_HISTORY = 500;

  // Per-coin last spread tracker
  const lastSpreads: Record<string, number> = {};

  bus.on("tick", (tick) => {
    if (tick.bid > 0) {
      state.lastPrices[tick.coin] = { mid: tick.mid, bid: tick.bid, ask: tick.ask };
      lastSpreads[tick.coin]      = tick.ask - tick.bid;
      state.lastUpdate = new Date();
    }
  });

  bus.on("candle", (candle: Candle) => {
    const coin = candle.coin ?? coins[0];
    if (!state.candleHistory[coin]) state.candleHistory[coin] = [];
    const hist = state.candleHistory[coin];

    // Upsert: live WebSocket resends the current candle as it builds
    const idx = hist.findIndex((c) => c.timestamp === candle.timestamp);
    if (idx >= 0) {
      hist[idx] = candle;
    } else {
      hist.push(candle);
      if (hist.length > MAX_CANDLE_HISTORY) hist.shift();

      // Record spread at this candle's open time (only for new bars)
      const spread = lastSpreads[coin] ?? 0;
      if (spread > 0) {
        if (!state.spreadHistory[coin]) state.spreadHistory[coin] = [];
        state.spreadHistory[coin].push({ t: candle.timestamp, value: spread });
        if (state.spreadHistory[coin].length > MAX_SPREAD_HISTORY) state.spreadHistory[coin].shift();
      }
    }
  });

  bus.on("signal", () => {
    state.signalCount++;
  });

  bus.on("orderbook", (snapshot) => {
    state.orderbooks[snapshot.coin] = snapshot;
  });

  // __dirname here is dist/dashboard/ at runtime; resolve back to the source tree
  // so Express reads .ejs files directly from src/ — no copy step ever needed.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const viewsDir  = resolve(__dirname, "../../src/dashboard/views");

  const app = express();
  app.set("view engine", "ejs");
  app.set("views", viewsDir);
  app.use(express.json());
  console.log(`[dashboard] Views directory: ${viewsDir}`);

  app.use("/", createRouter(logger, state, strategies, feed, executor, laneManager, dydxPoller));

  // env var takes precedence over the JSON config default so that DASHBOARD_PORT
  // in .env is respected without touching config files.
  const port = Number(process.env.DASHBOARD_PORT) || config.dashboard.port || 3002;
  app.listen(port, () => {
    console.log(`[dashboard] Listening on http://localhost:${port}`);
  });
}
