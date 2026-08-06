#!/usr/bin/env bash
# scripts/setup-live.sh
#
# One-shot setup for the mainnet live deployment.
# Run from ~/hyperliquid-trading-bot (the testnet directory).
# Creates ~/hyperliquid-trading-bot-live in paper-only observe mode.
#
# The live site executes against Hyperliquid MAINNET prices but places no
# real orders until you add HL_PRIVATE_KEY and set DRY_RUN=false in .env.

set -euo pipefail

LIVE_DIR="$HOME/hyperliquid-trading-bot-live"

# ── Safety checks ────────────────────────────────────────────────────────────

if [ -d "$LIVE_DIR" ]; then
  echo "[setup-live] ERROR: $LIVE_DIR already exists. To start over:" >&2
  echo "  pm2 delete hl-trading-bot-live snapshot-poller-live || true" >&2
  echo "  rm -rf $LIVE_DIR" >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "[setup-live] ERROR: must be run from inside the testnet git repo." >&2
  exit 1
fi

REMOTE=$(git remote get-url origin)
echo "[setup-live] Remote: $REMOTE"
echo "[setup-live] Live dir: $LIVE_DIR"
echo ""

# ── Clone ────────────────────────────────────────────────────────────────────

echo "[setup-live] Cloning repo..."
git clone "$REMOTE" "$LIVE_DIR"

cd "$LIVE_DIR"

# ── Build ────────────────────────────────────────────────────────────────────

echo "[setup-live] Installing dependencies..."
npm ci

echo "[setup-live] Building..."
npm run build

# ── Runtime directories ──────────────────────────────────────────────────────

mkdir -p data logs

# ── .env — paper-only mainnet, no private key ────────────────────────────────

cat > .env << 'ENVEOF'
# ─────────────────────────────────────────────────────────────────────────────
# hyperliquid-trading-bot-live — MAINNET deployment
#
# This site runs in paper-only observe mode until you complete steps 1–3:
#
#   1. Add your mainnet agent-wallet key to HL_PRIVATE_KEY
#   2. Set DRY_RUN=false
#   3. Add ADMIN_PASSWORD_HASH and SESSION_SECRET
#
# Then restart: HL_ENV=live pm2 restart hl-trading-bot-live --update-env
# ─────────────────────────────────────────────────────────────────────────────

# Mainnet agent-wallet key — generate a dedicated agent key on Hyperliquid.
# Leave blank to stay in paper-only observe mode.
HL_PRIVATE_KEY=

# Must remain mainnet in this deployment.
HL_NETWORK=mainnet

# DRY_RUN=true means no real orders even with a key present.
# Set to false only after adding HL_PRIVATE_KEY above.
DRY_RUN=true

# Funding and market data always from mainnet (read-only).
FUNDING_DATA_NETWORK=mainnet
MARKET_DATA_NETWORK=mainnet

# Port this deployment listens on (nginx proxies 443 → 3002).
DASHBOARD_PORT=3002

# Admin auth — fill in both to enable the admin login.
#
#   Generate password hash:
#     node -e "const b=require('bcryptjs'); b.hash('yourpassword',10).then(h=>console.log(h))"
#
#   Generate session secret:
#     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#
ADMIN_PASSWORD_HASH=
SESSION_SECRET=

# Telegram notifications (optional — leave blank to disable).
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ENVEOF

echo "[setup-live] Created .env (paper-only, no private key)"

# ── Register PM2 processes ───────────────────────────────────────────────────

echo "[setup-live] Starting PM2 processes (observe mode)..."
HL_ENV=live pm2 start ecosystem.config.cjs
pm2 save

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║    hyperliquid-trading-bot-live — ready (paper-only mode)     ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Running processes:"
pm2 list | grep -E "hl-trading-bot-live|snapshot-poller-live" || true
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "NEXT STEPS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. Point the DNS A record for howbrookquant.benhowbrook.xyz at this server."
echo ""
echo "2. Install the nginx config:"
echo ""
echo "     sudo cp $LIVE_DIR/config/nginx-howbrookquant.conf \\"
echo "              /etc/nginx/sites-available/howbrookquant.benhowbrook.xyz"
echo "     sudo ln -s /etc/nginx/sites-available/howbrookquant.benhowbrook.xyz \\"
echo "                /etc/nginx/sites-enabled/"
echo "     sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "3. Issue the TLS cert (after DNS propagates):"
echo ""
echo "     sudo certbot --nginx -d howbrookquant.benhowbrook.xyz"
echo ""
echo "4. Edit $LIVE_DIR/.env — add HL_PRIVATE_KEY, set DRY_RUN=false,"
echo "   add ADMIN_PASSWORD_HASH and SESSION_SECRET. Then:"
echo ""
echo "     HL_ENV=live pm2 restart hl-trading-bot-live --update-env"
echo ""
echo "5. (Optional) Set up nightly backups for the live database."
echo "   The backup script defaults to ~/backups/bot-db/ — create a"
echo "   separate cron entry targeting $LIVE_DIR/data/bot.db"
echo "   and a separate destination such as ~/backups/bot-db-live/."
echo ""
echo "Dashboard (paper mode, local): http://localhost:3002"
echo ""
