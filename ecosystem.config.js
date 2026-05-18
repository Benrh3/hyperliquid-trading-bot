module.exports = {
  apps: [
    {
      name: "hl-trading-bot",
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
        HL_NETWORK: "testnet",
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
  ],
};
