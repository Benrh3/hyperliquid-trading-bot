# Hyperliquid Trading Bot

[![CI](https://github.com/benhowbrook4/hyperliquid-trading-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/benhowbrook4/hyperliquid-trading-bot/actions/workflows/ci.yml)

A modular, event-driven perpetual-futures trading bot for [Hyperliquid](https://hyperliquid.xyz) (DEX) with an optional cross-venue funding-rate arbitrage strategy that spans Hyperliquid and dYdX v4.

> **Testnet-first by default.** Every component defaults to the Hyperliquid testnet and paper-simulation mode. Real orders require explicit opt-in via environment variables and UI toggles.

---

## Features

| Area | Detail |
|---|---|
| **Strategies** | Confluence (RSI + MACD + Bollinger + Volume), Trend Follow (EMA crossover), Cross-Venue Funding Basis (HL ↔ dYdX) |
| **Strategy Builder** | Visual form-based composer using 20 built-in indicators |
| **Backtesting** | Single-run and walk-forward backtest with parameter grid search |
| **Risk management** | Percentage-based sizing, portfolio concurrent-risk cap, daily-loss circuit breaker |
| **Dashboard** | Live web UI — bot cards, funding-rate dashboard, trade history, backtest, learn tab |
| **Multiple bots** | Pause/resume/delete per bot; each bot has independent equity, position, and P&L |
| **Reconciliation** | 60-second loop + post-trade trigger; orphaned positions detected and surfaced |
| **Notifications** | Optional Telegram alerts |

---

## Strategies

### Confluence (mean-reversion)
Requires at least N of 4 indicators to agree before entering: RSI overbought/oversold, MACD crossover, Bollinger Band touch, and volume spike. Exits when RSI returns toward neutral. Default: 2 of 4.

### Trend Follow (trend-following)
EMA(21) / EMA(55) crossover filtered by EMA(200) — only longs when above the 200-period MA, only shorts below. Exits on the opposite crossover.

### Cross-Venue Funding Basis (market-neutral carry)
Compares the BTC-USD (or other coin) perpetual funding rate on Hyperliquid against dYdX v4. Opens a short perp on the high-rate venue and a long perp on the low-rate venue. Net income is `spread × notional per hour`. Direction flips when a better spread appears (30% hurdle, 1-hour cooldown). Guards: 0.005%/hr minimum spread, 2% daily-loss circuit breaker. **Paper mode by default; requires `DYDX_TESTNET_MNEMONIC` for live orders.**

### Strategy Builder
Compose custom strategies from 20 built-in indicators (SMA, EMA, RSI, MACD, Bollinger, ATR, Stochastic, OBV, VWAP, and more) via a visual UI. Custom strategies appear everywhere built-in ones do.

---

## Requirements

- Node.js 20+
- npm 9+
- A Hyperliquid testnet wallet (free at [app.hyperliquid-testnet.xyz](https://app.hyperliquid-testnet.xyz))
- *(Optional)* A dYdX v4 testnet wallet for cross-venue live trading

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/hyperliquid-trading-bot
cd hyperliquid-trading-bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in at minimum:

```
HL_PRIVATE_KEY=0x<your testnet private key>
HL_NETWORK=testnet
DRY_RUN=true
```

> **Never commit your `.env` file.** It is already listed in `.gitignore`.

### 3. Fund the Hyperliquid testnet wallet

Visit [app.hyperliquid-testnet.xyz](https://app.hyperliquid-testnet.xyz) → Deposit → use the testnet faucet.

### 4. (Optional) Set up the dYdX testnet wallet

Required only for cross-venue **live** mode. Paper mode works without it.

```bash
# Derives your dYdX address and calls the testnet faucet
npm run dydx:setup
```

---

## Running

```bash
# Development (TypeScript, hot reload)
npm run dev

# Production (compile then start)
npm run build
npm start

# With pm2
pm2 start dist/index.js --name hl-trading-bot
```

The dashboard is at `http://localhost:3002` (or your `DASHBOARD_PORT`).

### Deployment

```bash
./deploy.sh
```

Runs `git pull --ff-only`, `npm ci`, `npm run build`, and `pm2 restart`. Fast-fails on uncommitted changes to tracked files; runtime config and `.env` are git-ignored and untouched by the pull.

---

## Configuration

| File | Purpose |
|---|---|
| `config/default.json` | Strategy, risk, and dashboard defaults |
| `config/bots.json` | Active bots (runtime, auto-created from `bots.json.example` on first start) |
| `config/custom-strategies.json` | User-built strategies (runtime) |
| `.env` | All secrets and environment overrides |

Runtime config files are **never committed** — each has a committed `.example` counterpart copied automatically on first start.

---

## Risk defaults

| Setting | Default | Meaning |
|---|---|---|
| `riskPerTradePercent` | 2.0 | % of equity at risk if stop-loss fires |
| `maxConcurrentRiskPercent` | 10.0 | Max total open risk across all live bots |
| `stopLossPercent` | 2.0 | Stop-loss threshold (%) |
| `maxLeverage` | 5 | Position scaled down if computed leverage exceeds this |
| `maxDailyLossPercent` | 5.0 | New entries blocked after this daily drawdown |

Position size formula: `notional = equity × riskPerTrade% ÷ stopLoss%`, capped at `maxLeverage × equity`.

---

## Testing

```bash
npm test
```

Covers cross-venue leg-placement atomicity (pre-flight abort, unwind on second-leg failure, naked-leg detection).

---

## SECURITY

### Secrets management

- **All secrets live only in `.env`**, which is git-ignored and never committed.
- `.env.example` contains only placeholder values — no real keys, mnemonics, or tokens.
- The Hyperliquid private key and dYdX mnemonic are loaded via `process.env` at runtime and never appear in source code, logs, or committed config files.

### Testnet by default

- `HL_NETWORK=testnet` is the default in `config/default.json`.
- `DRY_RUN=true` is the safe starting value — no real orders until explicitly set to `false`.
- The Settings page shows a mainnet-switch checklist; the toggle is disabled until all safety gates pass.
- The cross-venue strategy defaults to **paper mode**; live orders require `DYDX_TESTNET_MNEMONIC` AND an explicit per-bot UI toggle.

### Git history scan

The full 36-commit git history has been scanned with trufflehog (entropy + regex modes). **No private keys, mnemonics, or real `.env` files were found.** The only high-entropy findings are npm `sha512-` integrity hashes in `package-lock.json` (false positives).

If you fork this repo and believe a secret was committed in your fork's history, rotate the key immediately and rewrite history with `git filter-repo` or BFG Repo Cleaner before making the repo public.

### Responsible use

- This project is designed for **testnet exploration and education**.
- Mainnet use with real funds is entirely at your own risk.
- Keep your private key and mnemonic safe. Rotate immediately if exposed.

### Reporting vulnerabilities

Open a private [GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) rather than a public issue.

---

## License

MIT
