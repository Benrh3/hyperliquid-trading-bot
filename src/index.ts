import { bus } from "./events.js";
import { config, coins, hasValidPrivateKey } from "./config.js";
import { Logger } from "./logger.js";
import { startDashboard } from "./dashboard/server.js";
import { Executor } from "./executor.js";
import { Feed } from "./feed.js";
import { RsiStrategy } from "./strategy/rsi.js";
import { ConfluenceStrategy } from "./strategy/confluence.js";
import { FundingRateStrategy } from "./strategy/funding-rate.js";
import { RiskManager } from "./risk.js";
import { initNotifications } from "./notifications.js";
import type { Candle, Signal } from "./events.js";
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

// 3. Strategies — all run in parallel on each candle
function buildStrategies(): Strategy[] {
  const active: Strategy[] = [];

  switch (config.strategy.type) {
    case "rsi":
      active.push(new RsiStrategy());
      break;
    case "confluence":
    default:
      active.push(new ConfluenceStrategy());
      break;
  }

  // Funding-rate strategy always runs alongside the primary strategy
  active.push(new FundingRateStrategy());

  return active;
}

const strategies = buildStrategies();
console.log(`[init] Strategies: ${strategies.map((s) => s.name).join(", ")}`);

// 4. Risk manager
const risk = new RiskManager(1000);
console.log("[init] Risk manager ready");

// 5. Per-strategy, per-coin candle history buffers
const MAX_HISTORY = 200;
const candleHistories = new Map<string, Candle[]>(); // key: `${strategy.name}:${coin}`
for (const s of strategies) {
  for (const coin of coins) {
    candleHistories.set(`${s.name}:${coin}`, []);
  }
}

// 6. Feed — create before dashboard so the dashboard can reference it for interval changes
const feed = new Feed();

// 7. Dashboard — pass strategies, feed, and executor
startDashboard(logger, strategies, feed, executor);

// ─── Event wiring ─────────────────────────────────────────

bus.on("candle", (candle) => {
  const candleCoin = candle.coin ?? coins[0];
  for (const s of strategies) {
    const key     = `${s.name}:${candleCoin}`;
    const history = candleHistories.get(key) ?? [];
    if (!candleHistories.has(key)) candleHistories.set(key, history);

    history.push(candle);
    if (history.length > MAX_HISTORY) history.shift();

    const signal = s.onCandle(candle, history);
    if (signal) {
      console.log(`[${s.name}] Signal: ${signal.side} ${signal.coin} — ${signal.reason}`);
      bus.emit("signal", signal);
    }
  }
});

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

// ─── Start feed (fetches 500 historical candles, then subscribes) ─────────
await feed.start();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[init] Shutting down...");
  await feed.stop();
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
