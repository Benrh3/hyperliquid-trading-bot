module.exports = {
  apps: [
    {
      name: "hl-trading-bot",
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
        HL_NETWORK: "testnet",
        DASHBOARD_PORT: "3001",
      },
      env_production: {
        NODE_ENV: "production",
        HL_NETWORK: "mainnet",
      },
      // Log config
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/error.log",
      out_file: "logs/output.log",
      merge_logs: true,
    },
    {
      // Observe-only Market data subsystem (market-spec.md). Isolated process:
      // an upstream outage or crash here must never affect hl-trading-bot.
      name: "snapshot-poller",
      script: "dist/snapshot-poller.js",
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
