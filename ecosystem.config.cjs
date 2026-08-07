// Set HL_ENV=live when starting processes in ~/hyperliquid-trading-bot-live/.
// Leave unset (the default) for the testnet deployment in ~/hyperliquid-trading-bot/.
//
// Port assignments (permanent — do not change without updating CLAUDE.md):
//   testnet  hl-trading-bot       → 3005
//   live     hl-trading-bot-live  → 3002
const live = process.env.HL_ENV === "live";

module.exports = {
  apps: [
    {
      name: live ? "hl-trading-bot-live" : "hl-trading-bot",
      script: "dist/index.js",
      // cwd MUST be explicit: without it PM2's default cwd is shell-dependent and
      // drifts across restarts/resurrects, causing all relative file paths
      // (data/bot.db, config/*.json, .env) to resolve against the wrong directory.
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
        // HL_NETWORK is explicit in both cases — never rely on a default.
        HL_NETWORK: live ? "mainnet" : "testnet",
        // Ports are hardcoded here so they survive any pm2 restart and are
        // never overridden by a .env file (dotenv no longer uses override:true).
        DASHBOARD_PORT: live ? "3002" : "3005",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/error.log",
      out_file: "logs/output.log",
      merge_logs: true,
    },
    {
      // Observe-only Market data subsystem (market-spec.md). Isolated process:
      // an upstream outage or crash here must never affect hl-trading-bot.
      name: live ? "snapshot-poller-live" : "snapshot-poller",
      script: "dist/snapshot-poller.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "128M",
      env: {
        NODE_ENV: "production",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/snapshot-poller-error.log",
      out_file: "logs/snapshot-poller-output.log",
      merge_logs: true,
    },
  ],
};
