#!/usr/bin/env bash
# deploy.sh — pull latest, build, restart pm2.
# Exits immediately on any failure; never prints "Deployed." unless every step succeeded.
#
# Runtime config files (config/bots.json, config/custom-strategies.json) are
# git-ignored so that changes made at runtime never dirty the tracked tree.
# git pull therefore never touches them — your live bot configuration is safe.
# On a fresh clone, index.ts copies *.json.example → *.json automatically.

set -euo pipefail

# ── 1. Pull latest changes (fast-forward only) ───────────────────────────────
echo "[deploy] Pulling latest changes..."

# Detect modifications to TRACKED files only.
# git-ignored files (bots.json, .env, *.db …) are intentionally excluded;
# they live on the server and must not block deploys.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo ""
  echo "[deploy] ERROR: Working tree has uncommitted changes to tracked files."
  echo "         Stash or reset them before deploying:"
  echo ""
  echo "             git stash          # to save and restore later"
  echo "             git checkout -- .  # to discard all local changes"
  echo ""
  exit 1
fi

# --ff-only refuses to auto-merge; it fails if the pull would require a merge commit
if ! git pull --ff-only; then
  echo ""
  echo "[deploy] ERROR: git pull --ff-only failed."
  echo "         This usually means the local branch has diverged from origin."
  echo "         Resolve the divergence manually, then re-run deploy.sh:"
  echo ""
  echo "             git fetch origin"
  echo "             git log --oneline HEAD..origin/main  # see what's incoming"
  echo "             git reset --hard origin/main         # discard local commits"
  echo ""
  exit 1
fi

# ── 2. Install dependencies ───────────────────────────────────────────────────
# Must include devDependencies: TypeScript type packages (@types/*) are dev deps
# but are required at compile time. --omit=dev is only safe when deploying a
# pre-built artifact; here we build on the deploy machine, so all deps are needed.
echo "[deploy] Installing dependencies..."
npm ci

# ── 3. Build TypeScript ───────────────────────────────────────────────────────
echo "[deploy] Building..."
npm run build

# ── 4. Restart pm2 ───────────────────────────────────────────────────────────
echo "[deploy] Restarting pm2 process..."
if [ "${HL_ENV:-}" = "live" ]; then
  pm2 restart hl-trading-bot-live --update-env
else
  pm2 restart hl-trading-bot --update-env
fi

echo ""
echo "[deploy] Deployed successfully."
