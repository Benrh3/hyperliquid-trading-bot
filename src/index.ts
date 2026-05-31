import { bus } from "./events.js";
import { config, coins, hasValidPrivateKey } from "./config.js";
import { Logger } from "./logger.js";
import { startDashboard } from "./dashboard/server.js";
import { Executor } from "./executor.js";
import { Feed } from "./feed.js";
import { FundingRateStrategy } from "./strategy/funding-rate.js";
import { BotManager } from "./bot-manager.js";
import { DydxFundingPoller } from "./dydx-funding.js";
import { loadCustomDefs, customDefToRegistryEntry } from "./strategy/custom-strategy.js";
import { STRATEGY_REGISTRY } from "./strategy/registry.js";
import { RiskManager } from "./risk.js";
import { initNotifications } from "./notifications.js";
import type { Signal } from "./events.js";
import type { Strategy } from "./strategy/base.js";

// ─── Startup banner ───────────────────────────────────────
console.log(`
╔══════════════════════════════════════════╗
║     Hyperliquid Trading Bot v0.1.0       ║
║     Network: ${config.exchange.network.padEnd(28)}║
║     Coins:   ${coins.join(", ").padEnd(28)}║
║     Strategy: ${config.strategy.type.padEnd(27)}║
╚══════════════════════════════════════════╝
`);

// ─── Validate config ──────────────────────────────────────
const keyReady = hasValidPrivateKey();
console.log(keyReady ? "[init] Private key loaded" : "[init] No valid private key — executor disabled, running in observe-only mode");

// ─── Initialise modules ───────────────────────────────────

// 1. Logger — first so all subsequent bus events are captured
const logger = new Logger();

// 1b. Notifications (Telegram — no-op if env vars not set)
initNotifications();

// 2. Executor (only when a real key is present; dry-run by default)
let executor: Executor | undefined;
if (keyReady) {
  const dryRun = process.env.DRY_RUN !== "false";
  executor = new Executor(dryRun);
}

// 3. Strategies visible to the Strategies page (funding-rate poller only)
//    Candle strategies are managed by LaneManager below.
const strategies: Strategy[] = [new FundingRateStrategy()];
console.log(`[init] Strategies: ${strategies.map((s) => s.name).join(", ")}`);

// 3a-custom. Load user-built strategies from config/custom-strategies.json into the registry
//            They live in the same registry, so they appear everywhere automatically.
for (const def of loadCustomDefs()) {
  STRATEGY_REGISTRY.push(customDefToRegistryEntry(def));
}
console.log(`[init] Custom strategies loaded: ${STRATEGY_REGISTRY.filter(e => e.isCustom).length}`);

// 3b. Bot manager — one independent paper bot per (strategy + coin + timeframe)
const laneManager = new BotManager();

// 3c. dYdX v4 funding rate poller (read-only, no wallet required)
const dydxPoller = new DydxFundingPoller();

// 4. Risk manager
const risk = new RiskManager(1000);
console.log("[init] Risk manager ready");

// 5. Feed — create before dashboard so the dashboard can reference it for interval changes
const feed = new Feed();

// 6. Dashboard — pass strategies, feed, executor, lane manager, and dYdX poller
startDashboard(logger, strategies, feed, executor, laneManager, dydxPoller);

// ─── Event wiring ─────────────────────────────────────────

bus.on("signal:rejected", (signal: Signal, reason: string) => {
  console.log(`[risk] REJECTED ${signal.side} ${signal.coin}: ${reason}`);
});

bus.on("error", (module: string, error: Error) => {
  console.error(`[${module}] ERROR:`, error.message);
});

// ─── Initialise strategies ────────────────────────────────
for (const s of strategies) {
  if (s.init) await s.init([]);
}

// ─── Start feed, lane manager, and dYdX poller ───────────
await feed.start();
await laneManager.start();
await dydxPoller.start();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[init] Shutting down...");
  await feed.stop();
  await laneManager.stop();
  dydxPoller.stop();
  for (const s of strategies) {
    if ("stop" in s && typeof (s as { stop?: () => void }).stop === "function") {
      (s as { stop: () => void }).stop();
    }
  }
  logger.close();
  process.exit(0);
});

void risk;
console.log("[init] Bot is running. Press Ctrl+C to stop.");
