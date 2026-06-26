#!/usr/bin/env bash
# backup-db.sh — nightly consistent backup of data/bot.db
#
# Two backup paths:
#   1. Local: SQLite .backup (binary) with 7-daily + 4-weekly retention → fast restore
#   2. Off-server: SQLite .dump (SQL text) → git commit → push to private GitHub repo
#      (git diffs text efficiently; binary .db would bloat the repo)
#
# The GitHub repo (howbrook-quant-backups) must already be initialized:
#   cd ~ && mkdir howbrook-quant-backups && cd howbrook-quant-backups
#   git init && git remote add origin git@github.com:Benrh3/howbrook-quant-backups.git
#
# Usage:
#   cd ~/hyperliquid-trading-bot && bash scripts/backup-db.sh

set -euo pipefail

DB="${DB_PATH:-data/bot.db}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/bot-db}"
GIT_BACKUP_DIR="${GIT_BACKUP_DIR:-$HOME/howbrook-quant-backups}"
DATE=$(date +%F)
DAY_OF_WEEK=$(date +%u)  # 1=Monday ... 7=Sunday

if [ ! -f "$DB" ]; then
  echo "[backup] ERROR: $DB not found — nothing to back up"
  exit 1
fi

# ── 1. Local binary backup (fast restore) ────────────────────────────────────
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

DAILY_FILE="$BACKUP_DIR/daily/bot-db-${DATE}.db"
echo "[backup] Local binary backup: $DB → $DAILY_FILE"
sqlite3 "$DB" ".backup '$DAILY_FILE'"
FILESIZE=$(du -h "$DAILY_FILE" | cut -f1)
echo "[backup] Daily backup complete ($FILESIZE)"

# Weekly snapshot (Monday)
if [ "$DAY_OF_WEEK" = "1" ]; then
  WEEKLY_FILE="$BACKUP_DIR/weekly/bot-db-${DATE}.db"
  cp "$DAILY_FILE" "$WEEKLY_FILE"
  echo "[backup] Weekly snapshot: $WEEKLY_FILE"
fi

# Retention: keep last 7 daily + last 4 weekly
find "$BACKUP_DIR/daily" -name "bot-db-*.db" -mtime +7 -delete 2>/dev/null || true
ls -t "$BACKUP_DIR/weekly"/bot-db-*.db 2>/dev/null | tail -n +5 | xargs rm -f 2>/dev/null || true
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "[backup] Local retention applied. Total: $TOTAL_SIZE"

# ── 2. Off-server: SQL dump → git push to private GitHub repo ────────────────
if [ ! -d "$GIT_BACKUP_DIR/.git" ]; then
  echo "[backup] Git backup dir not initialized at $GIT_BACKUP_DIR — skipping off-server"
  echo "[backup] To set up: cd ~ && mkdir howbrook-quant-backups && cd howbrook-quant-backups"
  echo "         git init && git remote add origin git@github.com:Benrh3/howbrook-quant-backups.git"
  exit 0
fi

echo "[backup] SQL dump for git: $DB → $GIT_BACKUP_DIR/bot-db.sql"
sqlite3 "$DB" ".dump" > "$GIT_BACKUP_DIR/bot-db.sql"
DUMP_SIZE=$(du -h "$GIT_BACKUP_DIR/bot-db.sql" | cut -f1)
echo "[backup] Dump complete ($DUMP_SIZE)"

cd "$GIT_BACKUP_DIR"
git add bot-db.sql
# Only commit if there are changes (avoids empty commits on quiet days)
if git diff --cached --quiet; then
  echo "[backup] No changes since last backup — skipping commit"
else
  git commit -m "backup $DATE"
  git push origin main
  echo "[backup] Pushed to GitHub (howbrook-quant-backups)"
fi

echo "[backup] Done"
