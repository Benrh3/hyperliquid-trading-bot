import { bus } from "./events.js";
import { config, hasValidPrivateKey } from "./config.js";
import { Logger } from "./logger.js";
import { startDashboard } from "./dashboard/server.js";
import { Executor } from "./executor.js";
import { Feed } from "./feed.js";
import { RsiStrategy } from "./strategy/rsi.js";
import { ConfluenceStrategy } from "./strategy/confluence.js";
import { RiskManager } from "./risk.js";
import type { Candle, Signal } from "./events.js";
import type { Strategy } from "./strategy/base.js";

// ─── Startup banner ───────────────────────────────────────
console.log(`
╔══════════════════════════════════════════╗
║     Hyperliquid Trading Bot v0.1.0       ║
║     Network: ${config.exchange.network.padEnd(28)}║
║     Coin:    ${config.exchange.coin.padEnd(28)}║
║     Strategy: ${config.strategy.type.padEnd(27)}║
╚══════════════════════════════════════════╝
`);

// ─── Validate config ──────────────────────────────────────
const keyReady = hasValidPrivateKey();
console.log(keyReady ? "[init] Private key loaded" : "[init] No valid private key — executor disabled, running in observe-only mode");

// ─── Initialise modules ───────────────────────────────────

// 1. Logger — first so all subsequent bus events are captured
const logger = new Logger();

// 2. Dashboard
startDashboard(logger);

// 3. Executor (only when a real key is present; dry-run by default)
if (keyReady) {
  const dryRun = process.env.DRY_RUN !== "false";
  new Executor(dryRun);
}

// 4. Strategy
function createStrategy(): Strategy {
  switch (config.strategy.type) {
    case "rsi":         return new RsiStrategy();
    case "confluence":  return new ConfluenceStrategy();
    default:
      console.warn(`[init] Unknown strategy "${config.strategy.type}", defaulting to confluence`);
      return new ConfluenceStrategy();
  }
}
const strategy = createStrategy();
console.log(`[init] Strategy: ${strategy.name}`);

// 5. Risk manager (starting with placeholder balance — will be fetched from exchange)
const risk = new RiskManager(1000);
console.log("[init] Risk manager ready");

// 6. Candle history buffer
const candleHistory: Candle[] = [];
const MAX_HISTORY = 200;

// ─── Event wiring ─────────────────────────────────────────

// When a new candle arrives, run the strategy
bus.on("candle", (candle) => {
  candleHistory.push(candle);
  if (candleHistory.length > MAX_HISTORY) {
    candleHistory.shift();
  }

  const signal = strategy.onCandle(candle, candleHistory);
  if (signal) {
    console.log(`[strategy] Signal: ${signal.side} — ${signal.reason}`);
    bus.emit("signal", signal);
  }
});

// When a signal is rejected, log why
bus.on("signal:rejected", (signal: Signal, reason: string) => {
  console.log(`[risk] REJECTED ${signal.side} ${signal.coin}: ${reason}`);
});

// Global error handler
bus.on("error", (module: string, error: Error) => {
  console.error(`[${module}] ERROR:`, error.message);
});

// ─── Start real WebSocket feed ────────────────────────────
const feed = new Feed();
await feed.start();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[init] Shutting down...");
  await feed.stop();
  logger.close();
  process.exit(0);
});

console.log("[init] Bot is running. Press Ctrl+C to stop.");
