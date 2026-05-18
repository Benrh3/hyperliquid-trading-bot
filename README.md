# Hyperliquid Trading Bot

A modular, event-driven trading bot for [Hyperliquid](https://hyperliquid.xyz) perpetual futures, built with Node.js and TypeScript.

> ⚠️ **Disclaimer**: This bot is for educational and research purposes. Trading cryptocurrencies involves substantial risk of loss. Never trade with funds you cannot afford to lose. Always test on testnet before deploying with real funds.

## Architecture

```
┌─────────────────────────────────────────────┐
│            Hyperliquid Exchange              │
│         (Testnet / Mainnet API)             │
└──────────┬──────────────────┬───────────────┘
           │ Market data      │ Orders
           ▼                  ▲
┌─────────────────────────────────────────────┐
│              Bot Core (Node.js)             │
│                                             │
│  ┌──────────────┐    ┌──────────────────┐   │
│  │  Data Feed   │───▶│ Strategy Engine   │   │
│  │  (WebSocket) │    │ (Signal Logic)    │   │
│  └──────────────┘    └────────┬─────────┘   │
│                               │ Signal      │
│  ┌──────────────┐    ┌───────▼──────────┐   │
│  │ Risk Manager │◀───│ Order Executor    │   │
│  │ (Limits/SL)  │───▶│ (SDK Client)     │   │
│  └──────────────┘    └──────────────────┘   │
│                                             │
│  ┌──────────────────────────────────────┐   │
│  │   Event Bus (EventEmitter)           │   │
│  └──────────────────────────────────────┘   │
└──────────┬──────────────────────────────────┘
           │
    ┌──────▼──────┐    ┌──────────────────┐
    │   SQLite    │    │ Admin Dashboard   │
    │   Logger    │◀──▶│ (Express + EJS)   │
    └─────────────┘    └──────────────────┘
```

## Features

- **Real-time data feed** — WebSocket subscription for live orderbook, trades, and candle data
- **Pluggable strategies** — Swap strategies without touching the plumbing (RSI, EMA crossover, grid, etc.)
- **Risk management** — Configurable max position size, daily loss limits, leverage caps, and automatic stop-loss
- **Event-driven architecture** — Decoupled modules communicate via Node.js EventEmitter
- **Trade logging** — Full trade history, P&L tracking, and error logging with SQLite
- **Admin dashboard** — Local Express web UI for monitoring positions, P&L, and bot health
- **Testnet first** — Identical API for testnet and mainnet; develop risk-free

## Tech Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript
- **Exchange SDK**: [@nktkas/hyperliquid](https://github.com/nktkas/hyperliquid)
- **Wallet**: [viem](https://viem.sh) (for account/key management)
- **Database**: better-sqlite3
- **Dashboard**: Express + EJS
- **Process Manager**: PM2 (production deployment)
- **Indicators**: technicalindicators (RSI, EMA, MACD, Bollinger Bands)

## Project Structure

```
hyperliquid-trading-bot/
├── src/
│   ├── index.ts              # Entry point — wires all modules together
│   ├── config.ts             # Loads config + env vars
│   ├── feed.ts               # WebSocket data feed (candles, orderbook, trades)
│   ├── strategy/
│   │   ├── base.ts           # Abstract strategy interface
│   │   ├── rsi.ts            # RSI mean-reversion strategy
│   │   └── ema-crossover.ts  # EMA crossover trend strategy
│   ├── risk.ts               # Risk manager (position limits, daily loss, leverage)
│   ├── executor.ts           # Order execution via ExchangeClient
│   ├── logger.ts             # SQLite trade/error logging
│   ├── events.ts             # Typed event bus
│   └── dashboard/
│       ├── server.ts         # Express app setup
│       ├── routes.ts         # API + page routes
│       └── views/
│           ├── index.ejs     # Dashboard home
│           └── trades.ejs    # Trade history
├── config/
│   ├── default.json          # Default strategy params + risk limits
│   └── testnet.json          # Testnet-specific overrides
├── migrations/
│   └── 001_init.sql          # SQLite schema
├── tests/
│   ├── strategy.test.ts      # Strategy unit tests
│   └── risk.test.ts          # Risk manager tests
├── .env.example              # Template for secrets
├── .gitignore
├── ecosystem.config.js       # PM2 deployment config
├── tsconfig.json
├── package.json
└── README.md
```

## Getting Started

### Prerequisites

- Node.js 20+ installed
- A Hyperliquid testnet account ([get one here](https://app.hyperliquid-testnet.xyz))
- Testnet API wallet keys (Settings → API on the testnet site)

### Installation

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/hyperliquid-trading-bot.git
cd hyperliquid-trading-bot

# Install dependencies
npm install

# Copy env template and add your testnet private key
cp .env.example .env
# Edit .env with your private key
```

### Configuration

Edit `config/default.json` to set your strategy parameters:

```json
{
  "exchange": {
    "network": "testnet",
    "coin": "BTC",
    "leverage": 3
  },
  "strategy": {
    "type": "rsi",
    "interval": "15m",
    "rsiPeriod": 14,
    "overbought": 70,
    "oversold": 30
  },
  "risk": {
    "maxPositionSizeUsd": 500,
    "maxDailyLossPercent": 5,
    "maxLeverage": 5,
    "stopLossPercent": 2
  },
  "dashboard": {
    "port": 3000
  }
}
```

### Running

```bash
# Development (with hot reload)
npm run dev

# Build + run
npm run build
npm start

# Run tests
npm test
```

### Production Deployment (Vultr VPS)

```bash
# On your VPS
git pull origin main
npm ci --production
npm run build

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
```

## API Endpoints

The bot exposes a local dashboard at `http://localhost:3000`:

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard overview (positions, P&L, bot status) |
| `GET /trades` | Trade history with filters |
| `GET /api/status` | Bot health check (JSON) |
| `GET /api/positions` | Current open positions (JSON) |
| `POST /api/strategy/pause` | Pause the strategy |
| `POST /api/strategy/resume` | Resume the strategy |

## Strategies

### RSI Mean Reversion (default)
Opens a long when RSI drops below the oversold threshold, shorts when RSI rises above overbought. Closes positions when RSI returns to neutral.

### EMA Crossover
Goes long when the fast EMA crosses above the slow EMA, shorts on the reverse. Uses configurable periods (default: 9/21).

### Adding a Custom Strategy

1. Create a new file in `src/strategy/`
2. Implement the `Strategy` interface from `base.ts`
3. Register it in `src/index.ts`

```typescript
import { Strategy, Signal } from './base';

export class MyStrategy implements Strategy {
  name = 'my-strategy';

  onCandle(candle: Candle): Signal | null {
    // Your logic here
    // Return { side: 'long' | 'short', reason: 'why' } or null
  }
}
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `HL_PRIVATE_KEY` | Hyperliquid API wallet private key | Yes |
| `HL_NETWORK` | `testnet` or `mainnet` | No (defaults to testnet) |
| `DASHBOARD_PORT` | Admin dashboard port | No (defaults to 3000) |

## Roadmap

- [ ] Core bot framework (event bus, config, logging)
- [ ] Data feed module (WebSocket + REST)
- [ ] RSI strategy implementation
- [ ] Risk manager
- [ ] Order executor
- [ ] SQLite trade logging
- [ ] Express admin dashboard
- [ ] EMA crossover strategy
- [ ] Backtesting engine (replay historical candles)
- [ ] Telegram/Discord notifications
- [ ] Multi-coin support

## License

MIT
