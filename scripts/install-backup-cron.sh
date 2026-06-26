#!/usr/bin/env bash
# install-backup-cron.sh — add the nightly DB backup to the user's crontab
#
# Prerequisites (already done on the server):
#   cd ~ && mkdir howbrook-quant-backups && cd howbrook-quant-backups
#   git init && git remote add origin git@github.com:Benrh3/howbrook-quant-backups.git
#
# Run once:
#   cd ~/hyperliquid-trading-bot && bash scripts/install-backup-cron.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_DIR/scripts/backup-db.sh"
LOG="$REPO_DIR/logs/backup.log"
CRON_LINE="0 3 * * * cd $REPO_DIR && bash $SCRIPT >> $LOG 2>&1"

mkdir -p "$REPO_DIR/logs"

# Check if already installed
if crontab -l 2>/dev/null | grep -qF "backup-db.sh"; then
  echo "[cron] backup-db.sh already in crontab — skipping"
  crontab -l | grep "backup-db"
  exit 0
fi

# Append to crontab
(crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
echo "[cron] Installed: nightly backup at 03:00 UTC"
echo "  $CRON_LINE"
echo ""
echo "What it does:"
echo "  1. Local binary backup → ~/backups/bot-db/ (7 daily + 4 weekly)"
echo "  2. SQL text dump → ~/howbrook-quant-backups/bot-db.sql → git push"
echo ""
echo "Test manually: cd $REPO_DIR && bash scripts/backup-db.sh"
