# CLAUDE.md — Project context for Claude Code

## What this is
A modular trading bot for Hyperliquid perpetual futures (DEX). TypeScript, Node.js 20+, event-driven architecture.

## Key SDK
- **@nktkas/hyperliquid** — TypeScript SDK for Hyperliquid API
  - `InfoClient` — read market data (orderbook, candles, positions)
  - `ExchangeClient` — place/cancel orders, requires wallet
  - `SubscriptionClient` — WebSocket real-time data
  - Transport: `HttpTransport` or `WebSocketTransport`
  - Wallet: use `privateKeyToAccount` from `viem/accounts`
- **API URLs**:
  - Testnet: `https://api.hyperliquid-testnet.xyz`
  - Mainnet: `https://api.hyperliquid.xyz`

## Architecture
Modules communicate via a typed EventEmitter bus (`src/events.ts`).
- `candle` event → Strategy processes it → emits `signal`
- `signal` → Risk manager evaluates → emits `signal:approved` or `signal:rejected`
- `signal:approved` → Executor places order via ExchangeClient → emits `trade`

## Build & run
```bash
npm install
npm run dev        # tsx watch mode
npm run build      # tsc → dist/
npm start          # node dist/index.js
npm test           # vitest
```

## Current state / TODO
Working: events.ts, config.ts, strategy/base.ts, strategy/rsi.ts, risk.ts, index.ts (with simulated feed)
Next modules to build:
1. `src/feed.ts` — Replace simulated candles with real WebSocket feed using SubscriptionClient
2. `src/executor.ts` — Wire up ExchangeClient to place real orders on testnet
3. `src/logger.ts` — SQLite logging using better-sqlite3 + migrations/001_init.sql
4. `src/dashboard/` — Express + EJS admin panel

## Conventions
- All imports use `.js` extension (Node16 module resolution)
- Config loaded from `config/default.json`, overridden by `config/{network}.json`
- Private key from `HL_PRIVATE_KEY` env var (never hardcoded)
- Every module logs with `[module-name]` prefix
