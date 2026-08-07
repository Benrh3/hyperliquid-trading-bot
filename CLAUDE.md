# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo.

## What this is

A Hyperliquid perpetual-futures trading bot with a live web dashboard, built in TypeScript on Node 20. The dashboard has two top-level pillars:

- **Trading Bot** — operate and monitor strategies (confluence, trend-follow, cross-venue funding basis between Hyperliquid and dYdX). Execution runs on Hyperliquid testnet; funding and market data are read from mainnet.
- **Market** — a multi-signal market-pressure and information-coefficient (IC) tracker for HYPE. Observe-only: a signal is not wired into any bot until its IC is measured and stable.

## Stack

- Node 20 + TypeScript, Express, EJS server-rendered views
- SQLite via `better-sqlite3` (`data/bot.db`) — shared by the bot and the Market poller
- `@nktkas/hyperliquid` SDK — `HttpTransport` for orders, `WebSocketTransport` for live data
- TradingView `lightweight-charts` (candlesticks, equity curve, order-book depth)
- PM2 process management, nginx reverse proxy + Let's Encrypt TLS
- GitHub Actions CI (tests + build on push)
- Auth: two-tier (public read / admin write), bcrypt + HMAC-SHA256 signed cookies, rate-limited login

## Layout

- `src/` TypeScript source · `dist/` compiled output
- `src/dashboard/views/` EJS views (served from `src/` in production)
  - `_head.ejs` — global design tokens + shared primitive CSS (single source of truth for styling)
  - `_nav.ejs` — shared two-pillar navigation partial
  - bot pillar: `index` (Overview), `strategies`, `bots`, `trades`, `backtest`, `builder`, `learn`, `settings`, `login`
  - `market.ejs` — the Market pillar (large single file; split candidate)
- `routes.ts` — single Express router; middleware sets `res.locals.pillar` (`bot`/`market`) and `res.locals.currentPath` for the nav
- `ecosystem.config.cjs` — PM2 apps; `HL_ENV=live` selects the mainnet pair (`hl-trading-bot-live` / `snapshot-poller-live`); default selects the testnet pair (`hl-trading-bot` / `snapshot-poller`)
- `deploy.sh` — pull → install → build → restart, with `set -euo pipefail` and a dirty-tree guard
- `scripts/check-ejs-scripts.sh` — the `check:ejs` guard (see gotchas)

## Design system

Dark-first, defined globally in `_head.ejs`. The per-pillar accent is the only thing that differs between sections.

- Palette: `--bg #0A0E14`, `--surface #0D1520`, `--surface2 #111E2D`, a faint `--border`, `--muted #3D5A78`
- Accent: Trading Bot = indigo `#818CF8`; Market = sky `#38BDF8` (a scoped override in `market.ejs`)
- Type: `--t-label` (11px uppercase) … `--t-hero` (40px); Inter for labels/body, Georgia for hero
- Spacing: `--sp-1`…`--sp-6` (4 / 8 / 12 / 16 / 20 / 24 px)
- **Green/red are reserved strictly for semantic up/down** (P&L, funding sign, order-book depth) — never decorative
- Shared primitives (global): `.signal-card` / `.sc-*`, `.chart-card` + toolbar, `.tf` / `.tf-group`, badges, `.caveat`

## Conventions and gotchas

- **EJS inline scripts:** use `function`-keyword syntax, not arrow functions that return object literals — the latter break silently. `npm run check:ejs` enforces this.
- **Views aren't compiled:** `tsc` does not copy `.ejs` files. Copy them after build (`cp -r src/dashboard/views dist/dashboard/views`); in production they are served from `src/`.
- **Runtime config is gitignored** and managed on the server: `bots.json`, `custom-strategies.json`, `lanes.json`. (`config/server.json` does not exist — ignore any references to it.)
- **Zombie-bot guard:** a deleted bot sets a `runtime.deleted` poison flag that is checked at every `await` boundary, so a stale async continuation can never open a real position after deletion.
- **Reskins are presentation-only:** never rename element IDs the JS targets, never touch routes or data logic, and always preserve the semantic green/red.
- **`data/` is irreplaceable:** `bot.db` plus the accumulating Market snapshot history. Never delete it during cleanup.
- **Backups:** `scripts/backup-db.sh` runs nightly via cron (03:00 UTC). Two paths: (1) local binary `.backup` → `~/backups/bot-db/` with 7-daily + 4-weekly retention for fast restore; (2) SQL `.dump` → `~/howbrook-quant-backups/bot-db.sql` → git push to private `Benrh3/howbrook-quant-backups` repo (text diffs efficiently, won't bloat). Install: `bash scripts/install-backup-cron.sh`. Restore from local: `pm2 stop all && cp ~/backups/bot-db/daily/bot-db-YYYY-MM-DD.db data/bot.db && pm2 start all`. Restore from GitHub: `cd ~/howbrook-quant-backups && git pull && sqlite3 ~/hyperliquid-trading-bot/data/bot.db < bot-db.sql`.

## Port map

This server is shared. Do **not** use a port that belongs to another service.

| Port | Service | Notes |
|------|---------|-------|
| 3000 | docker-proxy | |
| 3001 | rmzcars | |
| **3002** | **hl-trading-bot-live** | mainnet dashboard (`howbrookquant.benhowbrook.xyz`) |
| 3004 | next-server | |
| **3005** | **hl-trading-bot** | testnet dashboard (`testnet.benhowbrook.xyz`) |
| 3333 | benhowbrook-api | |
| 4010 | datum | |
| 7575 | server | |

Ports for this repo are hardcoded in `ecosystem.config.cjs` `env.DASHBOARD_PORT` and must not be changed without updating this table. `dotenv` does not use `override:true`, so `.env` files cannot silently change ports.

## Deploy

```sh
# local — always run before pushing
npm test && npm run build && git push

# testnet server (~/hyperliquid-trading-bot)
cd ~/hyperliquid-trading-bot && ./deploy.sh          # restarts hl-trading-bot (port 3005)

# live server (~/hyperliquid-trading-bot-live)
cd ~/hyperliquid-trading-bot-live && HL_ENV=live ./deploy.sh   # restarts hl-trading-bot-live (port 3002)
```

For view/CSS-only changes, leave the `snapshot-poller` PM2 process untouched. PM2 logs are bounded by `pm2-logrotate`.

## Testing

`npm test` must pass before any deploy. CI runs the test suite and a build on every push.

## Working style

- Architecture, diagnostics, and prompt-writing happen in chat; Claude Code makes the file edits.
- Keep sessions short and task-scoped; commit between tasks.
- The running task list lives in `BACKLOG.md` (gitignored, never committed) as Now / Next / Parked / Anomalies / Done.
