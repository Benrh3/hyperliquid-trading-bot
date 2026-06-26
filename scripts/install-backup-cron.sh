#!/usr/bin/env bash
# install-backup-cron.sh — add the nightly DB backup to the user's crontab
#
# Run once on the server:
#   cd ~/hyperliquid-trading-bot && bash scripts/install-backup-cron.sh
#
# To set up off-server backup, add to .env or export before running:
#   export BACKUP_REMOTE=b2:howbrook-backups/bot-db
#   OR
#   export BACKUP_REMOTE=user@backuphost:~/backups/bot-db

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_DIR/scripts/backup-db.sh"
LOG="$REPO_DIR/logs/backup.log"
CRON_LINE="0 3 * * * cd $REPO_DIR && bash $SCRIPT >> $LOG 2>&1"

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
echo "To enable off-server copies, set BACKUP_REMOTE in your .env:"
echo "  echo 'BACKUP_REMOTE=b2:howbrook-backups/bot-db' >> $REPO_DIR/.env"
echo ""
echo "Test manually: cd $REPO_DIR && bash scripts/backup-db.sh"
