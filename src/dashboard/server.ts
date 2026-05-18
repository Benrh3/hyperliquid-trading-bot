import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { bus } from "../events.js";
import { config } from "../config.js";
import type { Logger } from "../logger.js";
import { createRouter } from "./routes.js";

export interface BotState {
  lastPrice: number;
  lastBid: number;
  lastAsk: number;
  lastUpdate: Date | null;
  signalCount: number;
  startedAt: Date;
  priceHistory: { t: number; price: number }[];
}

export function startDashboard(logger: Logger): void {
  const state: BotState = {
    lastPrice: 0,
    lastBid: 0,
    lastAsk: 0,
    lastUpdate: null,
    signalCount: 0,
    startedAt: new Date(),
    priceHistory: [],
  };

  const MAX_PRICE_HISTORY = 100;

  // Keep live state in sync with bus events
  bus.on("tick", (tick) => {
    if (tick.bid > 0) {
      state.lastPrice = tick.mid;
      state.lastBid = tick.bid;
      state.lastAsk = tick.ask;
      state.lastUpdate = new Date();
      state.priceHistory.push({ t: tick.timestamp, price: tick.mid });
      if (state.priceHistory.length > MAX_PRICE_HISTORY) {
        state.priceHistory.shift();
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

  app.use("/", createRouter(logger, state));

  const port = config.dashboard.port;
  app.listen(port, () => {
    console.log(`[dashboard] Listening on http://localhost:${port}`);
  });
}
