import { bus } from "./events.js";
import { config, coins, hasValidPrivateKey, getPrivateKey } from "./config.js";
import { Logger } from "./logger.js";
import { startDashboard } from "./dashboard/server.js";
import { Executor } from "./executor.js";
import { HyperliquidVenue } from "./venues/hyperliquid.js";
import { Feed } from "./feed.js";
import { FundingRateStrategy } from "./strategy/funding-rate.js";
import { BotManager } from "./bot-manager.js";
import { DydxFundingPoller } from "./dydx-funding.js";
import { CrossVenueFundingBasis } from "./cross-venue-funding.js";
import { DydxVenue } from "./venues/dydx.js";
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

const isTestnet = config.exchange.network === "testnet";

// 2. Venue + Executor (only when a real key is present; dry-run by default).
//    hlVenue is kept in scope so it can be passed to BotManager too — live bots
//    call venue.openPosition/closePosition directly for any coin in the universe.
let executor: Executor            | undefined;
let hlVenue:  HyperliquidVenue    | undefined;
if (keyReady) {
  const dryRun = process.env.DRY_RUN !== "false";
  hlVenue  = new HyperliquidVenue(getPrivateKey(), isTestnet);
  executor = new Executor(hlVenue, dryRun);
}

// 2b. Cross-venue funding basis (HL ↔ dYdX, BTC, $1000 notional, paper mode by default).
//     Uses a read-only HyperliquidVenue (no wallet needed for rate reads) and a DydxVenue
//     that accepts an optional mnemonic for testnet execution.
const hlReadOnly   = new HyperliquidVenue(null, isTestnet);
const dydxMnemonic = process.env.DYDX_TESTNET_MNEMONIC?.trim();
const dydxVenue    = new DydxVenue(dydxMnemonic);
const crossVenue   = new CrossVenueFundingBasis(hlReadOnly, dydxVenue, "BTC", 1_000, logger);
console.log(
  dydxMnemonic
    ? "[init] Cross-venue strategy created — DYDX_TESTNET_MNEMONIC present (testnet execution available)"
    : "[init] Cross-venue strategy created — no DYDX_TESTNET_MNEMONIC (paper mode only)",
);

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

// 3b. Bot manager — passes hlVenue so LIVE bots can place real orders on any HL coin
const laneManager = new BotManager(hlVenue);

// 3c. dYdX v4 funding rate poller (read-only, no wallet required)
const dydxPoller = new DydxFundingPoller();

// 4. Risk manager
const risk = new RiskManager(1000);
console.log("[init] Risk manager ready");

// 5. Feed — create before dashboard so the dashboard can reference it for interval changes
const feed = new Feed();

// 6. Dashboard — pass strategies, feed, executor, lane manager, dYdX poller, and cross-venue strategy
startDashboard(logger, strategies, feed, executor, laneManager, dydxPoller, crossVenue);

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

// ─── Start feed, lane manager, dYdX poller, and cross-venue strategy ─────
await feed.start();
await laneManager.start();
await dydxPoller.start();

// Start cross-venue strategy independently — a network error on the first
// poll must not abort the rest of startup.
try {
  await crossVenue.start();
  console.log("[init] Cross-venue funding strategy started in paper mode (BTC · $1000 notional)");
} catch (e) {
  console.error("[init] Cross-venue strategy failed to start:", (e as Error).message);
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[init] Shutting down...");
  await feed.stop();
  await laneManager.stop();
  dydxPoller.stop();
  crossVenue.stop();
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
