// Entry point for the 'snapshot-poller' PM2 process — the observe-only
// Market data subsystem (market-spec.md §0, §7 stage 1).
//
// Isolated failure domain: this process only reads market data and writes to
// snapshot_metrics. It is never imported by, and never imports, the trading
// path (strategies, executor, risk, bot-manager).

import { copyFileSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { config as loadEnv } from "dotenv";
import { MarketStore } from "./market/store.js";
import { SnapshotPoller, type SnapshotPollerConfig } from "./market/poller.js";

loadEnv({ override: true });

console.log("[snapshot-poller] cwd:     ", process.cwd());
console.log("[snapshot-poller] database:", resolve(process.cwd(), "data/bot.db"));

// ── First-run bootstrap ───────────────────────────────────────────────────────
const configTarget  = resolve(process.cwd(), "config", "snapshot.json");
const configExample = `${configTarget}.example`;
if (!existsSync(configTarget) && existsSync(configExample)) {
  copyFileSync(configExample, configTarget);
  console.log("[snapshot-poller] Created config/snapshot.json from snapshot.json.example");
}

let pollerConfig: SnapshotPollerConfig = {};
try {
  pollerConfig = JSON.parse(readFileSync(configTarget, "utf-8")) as SnapshotPollerConfig;
} catch {
  console.log("[snapshot-poller] No config/snapshot.json found — using defaults (HYPE, 60s)");
}

const store  = new MarketStore();
const poller = new SnapshotPoller(store, pollerConfig);

await poller.start();

process.on("SIGINT", async () => {
  console.log("\n[snapshot-poller] Shutting down...");
  await poller.stop();
  store.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[snapshot-poller] Shutting down...");
  await poller.stop();
  store.close();
  process.exit(0);
});

console.log("[snapshot-poller] Running. Press Ctrl+C to stop.");
