import { copyFileSync, existsSync } from "fs";
import { resolve } from "path";
import { bus } from "./events.js";
import { config, coins, hasValidPrivateKey, getPrivateKey } from "./config.js";

// ── First-run bootstrap ───────────────────────────────────────────────────────
// If a runtime config file is absent (fresh clone or first deploy), copy its
// committed .example counterpart so the app can start without manual setup.
for (const name of ["bots.json", "custom-strategies.json"]) {
  const target  = resolve(process.cwd(), "config", name);
  const example = `${target}.example`;
  if (!existsSync(target) && existsSync(example)) {
    copyFileSync(example, target);
    console.log(`[init] Created ${name} from ${name}.example`);
  }
}
import { Logger } from "./logger.js";
import { startDashboard } from "./dashboard/server.js";
import { Executor } from "./executor.js";
import { HyperliquidVenue } from "./venues/hyperliquid.js";
import { DydxVenue } from "./venues/dydx.js";
import { Feed } from "./feed.js";
import { FundingRateStrategy } from "./strategy/funding-rate.js";
import { BotManager } from "./bot-manager.js";
import { DydxFundingPoller } from "./dydx-funding.js";
import { FundingMatrixPoller } from "./funding-matrix.js";
import { MarketStore } from "./market/store.js";
import { loadCustomDefs, customDefToRegistryEntry } from "./strategy/custom-strategy.js";
import { STRATEGY_REGISTRY } from "./strategy/registry.js";
import { RiskManager } from "./risk.js";
import Database from "better-sqlite3";
import { CvStateStore } from "./cv-state-store.js";
import { LiveSignalProvider } from "./market/live-signal-provider.js";
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
console.log(keyReady
  ? "[init] Private key loaded"
  : "[init] No valid private key — executor disabled, running in observe-only mode");

// ─── Initialise modules ───────────────────────────────────

// 1. Logger — first so all subsequent bus events are captured
const logger = new Logger();

// 1b. Notifications (Telegram — no-op if env vars not set)
initNotifications();

const isTestnet = config.exchange.network === "testnet";

// 2. HL venue + Executor (only when a real key is present; dry-run by default).
//    hlVenue is reused by BotManager so live bots on any coin can place real orders.
let executor: Executor         | undefined;
let hlVenue:  HyperliquidVenue | undefined;
if (keyReady) {
  const dryRun = process.env.DRY_RUN !== "false";
  hlVenue  = new HyperliquidVenue(getPrivateKey(), isTestnet);
  executor = new Executor(hlVenue, dryRun);
}

// 3. dYdX venue — read-only for funding rates; trading arm requires DYDX_TESTNET_MNEMONIC
const dydxMnemonic = process.env.DYDX_TESTNET_MNEMONIC?.trim();
const dydxVenue    = new DydxVenue(dydxMnemonic);
console.log(
  dydxMnemonic
    ? "[init] DYDX_TESTNET_MNEMONIC loaded — cross-venue live trading available"
    : "[init] No DYDX_TESTNET_MNEMONIC — cross-venue bots default to paper mode",
);

// 4. Strategies page (funding-rate strategy only — candle/cross-venue bots in BotManager)
const strategies: Strategy[] = [new FundingRateStrategy()];
console.log(`[init] Strategies: ${strategies.map((s) => s.name).join(", ")}`);

// 4a. Load user-built strategies from config/custom-strategies.json
for (const def of loadCustomDefs()) {
  STRATEGY_REGISTRY.push(customDefToRegistryEntry(def));
}
console.log(`[init] Custom strategies loaded: ${STRATEGY_REGISTRY.filter(e => e.isCustom).length}`);

// 5. Bot manager — manages all candle bots AND cross-venue bots.
//    Receives hlVenue (for live order placement) and dydxVenue (for cross-venue).
//    If no HL key, hlVenue is undefined and live bots warn on each trade attempt.
const cvDb = new Database("data/bot.db");
cvDb.pragma("journal_mode = WAL");
cvDb.pragma("busy_timeout = 5000");
const cvStateStore = new CvStateStore(cvDb);

// Separate WAL-mode connection for live signal lookups (shadow bots).
// WAL allows multiple readers alongside the writer (snapshot-poller) without blocking.
const signalDb = new Database("data/bot.db");
signalDb.pragma("journal_mode = WAL");
signalDb.pragma("busy_timeout = 5000");
const signalProvider = new LiveSignalProvider(signalDb);

const laneManager = new BotManager(hlVenue, dydxVenue, logger, cvStateStore, signalProvider);

// 6. dYdX funding poller (cross-exchange comparison on Strategies page)
const dydxPoller = new DydxFundingPoller();

// 6b. Funding matrix poller — bulk fetch all venues × all coins every 45 s
const fundingMatrix = new FundingMatrixPoller(logger);

// 6c. Market data store (read-only here) — powers GET /api/snapshots.
// Snapshots are written by the separate 'snapshot-poller' PM2 process; this
// process only reads the shared WAL-mode SQLite file.
const marketStore = new MarketStore();

// 7. Risk manager
const risk = new RiskManager(1000);
console.log("[init] Risk manager ready");

// 8. Feed
const feed = new Feed();

// 9. Dashboard
startDashboard(logger, strategies, feed, executor, laneManager, dydxPoller, fundingMatrix, marketStore);

// ─── Event wiring ─────────────────────────────────────────

bus.on("signal:rejected", (signal: Signal, reason: string) => {
  console.log(`[risk] REJECTED ${signal.side} ${signal.coin}: ${reason}`);
});

bus.on("error", (module: string, error: Error) => {
  console.error(`[${module}] ERROR:`, error.message);
});

// ─── Start ────────────────────────────────────────────────
for (const s of strategies) {
  if (s.init) await s.init([]);
}

await feed.start();
await laneManager.start(); // starts candle bots AND cross-venue bots
await dydxPoller.start();

// Start funding matrix poller (non-blocking — first poll runs in background)
void fundingMatrix.start().catch((e: Error) =>
  console.error("[init] Funding matrix poller failed to start:", e.message),
);

// Equity snapshot every 60 s — fire-and-forget, never blocks the bot loop
const EQUITY_SNAP_MS = 60_000;
setInterval(() => {
  const bots  = laneManager.getBotStates();
  const total = bots.reduce((sum, b) => sum + (b.equity ?? 0), 0);
  logger.snapshotEquity(total);
}, EQUITY_SNAP_MS);

// Retention policy — roll up rows older than 7 days, run hourly + on startup
void Promise.resolve().then(() => logger.runRetentionPolicy());
setInterval(() => {
  void Promise.resolve().then(() => logger.runRetentionPolicy());
}, 60 * 60_000);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[init] Shutting down...");
  await feed.stop();
  await laneManager.stop(); // stops all bots including cross-venue
  dydxPoller.stop();
  fundingMatrix.stop();
  marketStore.close();
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
