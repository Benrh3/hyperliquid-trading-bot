import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { bus } from "../events.js";
import { config } from "../config.js";
import type { Candle } from "../events.js";
import type { Logger } from "../logger.js";
import type { Strategy } from "../strategy/base.js";
import type { Feed } from "../feed.js";
import { createRouter } from "./routes.js";

export interface BotState {
  lastPrice: number;
  lastBid: number;
  lastAsk: number;
  lastUpdate: Date | null;
  signalCount: number;
  startedAt: Date;
  priceHistory: { t: number; price: number }[];
  candleHistory: Candle[];
  spreadHistory: { t: number; value: number }[];
  currentInterval: string;
}

export function startDashboard(logger: Logger, strategies: Strategy[] = [], feed?: Feed): void {
  const state: BotState = {
    lastPrice: 0,
    lastBid:   0,
    lastAsk:   0,
    lastUpdate: null,
    signalCount: 0,
    startedAt: new Date(),
    priceHistory:  [],
    candleHistory: [],
    spreadHistory: [],
    currentInterval: config.strategy.interval,
  };

  const MAX_PRICE_HISTORY  = 100;
  const MAX_CANDLE_HISTORY = 500;
  const MAX_SPREAD_HISTORY = 500;

  let lastSpread = 0;

  bus.on("tick", (tick) => {
    if (tick.bid > 0) {
      state.lastPrice = tick.mid;
      state.lastBid   = tick.bid;
      state.lastAsk   = tick.ask;
      lastSpread      = tick.ask - tick.bid;
      state.lastUpdate = new Date();
      state.priceHistory.push({ t: tick.timestamp, price: tick.mid });
      if (state.priceHistory.length > MAX_PRICE_HISTORY) state.priceHistory.shift();
    }
  });

  bus.on("candle", (candle: Candle) => {
    // Upsert: live WebSocket resends the current candle as it builds
    const idx = state.candleHistory.findIndex((c) => c.timestamp === candle.timestamp);
    if (idx >= 0) {
      state.candleHistory[idx] = candle;
    } else {
      state.candleHistory.push(candle);
      if (state.candleHistory.length > MAX_CANDLE_HISTORY) state.candleHistory.shift();

      // Record spread at this candle's open time (only for new bars)
      if (lastSpread > 0) {
        state.spreadHistory.push({ t: candle.timestamp, value: lastSpread });
        if (state.spreadHistory.length > MAX_SPREAD_HISTORY) state.spreadHistory.shift();
      }
    }
  });

  bus.on("signal", () => {
    state.signalCount++;
  });

  const __dirname = dirname(fileURLToPath(import.meta.url));

  const app = express();
  app.set("view engine", "ejs");
  app.set("views", join(__dirname, "views"));
  app.use(express.json());

  app.use("/", createRouter(logger, state, strategies, feed));

  const port = config.dashboard.port;
  app.listen(port, () => {
    console.log(`[dashboard] Listening on http://localhost:${port}`);
  });
}
