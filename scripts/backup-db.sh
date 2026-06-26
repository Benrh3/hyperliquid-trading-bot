#!/usr/bin/env bash
# backup-db.sh — nightly consistent backup of data/bot.db
#
# Uses SQLite's online-backup (.backup) for a crash-safe snapshot even
# while the app is writing in WAL mode. NEVER use raw cp on a live DB.
#
# Retention: 7 daily + 4 weekly (first-of-week kept), older pruned.
# Off-server: if BACKUP_REMOTE is set, copies via rclone or rsync.
#
# Usage:
#   BACKUP_DIR=~/backups/bot-db scripts/backup-db.sh
#   BACKUP_REMOTE=b2:howbrook-backups/bot-db scripts/backup-db.sh  (rclone)
#   BACKUP_REMOTE=user@host:~/backups/bot-db scripts/backup-db.sh  (rsync)

set -euo pipefail

DB="${DB_PATH:-data/bot.db}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/bot-db}"
DATE=$(date +%F)
DAY_OF_WEEK=$(date +%u)  # 1=Monday ... 7=Sunday

# ── 1. Ensure backup directory exists ────────────────────────────────────────
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

# ── 2. Consistent SQLite backup ─────────────────────────────────────────────
DAILY_FILE="$BACKUP_DIR/daily/bot-db-${DATE}.db"

if [ ! -f "$DB" ]; then
  echo "[backup] ERROR: $DB not found — nothing to back up"
  exit 1
fi

echo "[backup] Starting consistent backup of $DB → $DAILY_FILE"
sqlite3 "$DB" ".backup '$DAILY_FILE'"
FILESIZE=$(du -h "$DAILY_FILE" | cut -f1)
echo "[backup] Daily backup complete: $DAILY_FILE ($FILESIZE)"

# ── 3. Weekly snapshot (keep Monday's backup as the weekly) ──────────────────
if [ "$DAY_OF_WEEK" = "1" ]; then
  WEEKLY_FILE="$BACKUP_DIR/weekly/bot-db-${DATE}.db"
  cp "$DAILY_FILE" "$WEEKLY_FILE"
  echo "[backup] Weekly snapshot: $WEEKLY_FILE"
fi

# ── 4. Retention: keep last 7 daily + last 4 weekly ─────────────────────────
# Daily: delete files older than 7 days
find "$BACKUP_DIR/daily" -name "bot-db-*.db" -mtime +7 -delete 2>/dev/null || true
# Weekly: keep only the 4 most recent
ls -t "$BACKUP_DIR/weekly"/bot-db-*.db 2>/dev/null | tail -n +5 | xargs rm -f 2>/dev/null || true

TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "[backup] Retention applied. Total backup size: $TOTAL_SIZE"

# ── 5. Off-server copy (optional) ───────────────────────────────────────────
REMOTE="${BACKUP_REMOTE:-}"
if [ -z "$REMOTE" ]; then
  echo "[backup] BACKUP_REMOTE not set — skipping off-server copy"
  echo "[backup] Set BACKUP_REMOTE=b2:bucket/path (rclone) or user@host:path (rsync)"
  exit 0
fi

# Detect transport: if it contains ":" with no "/" before it, assume rsync/scp
if command -v rclone &>/dev/null && [[ "$REMOTE" == *":"* ]] && [[ "$REMOTE" != *"@"* ]]; then
  echo "[backup] Copying to remote via rclone: $REMOTE"
  rclone copy "$DAILY_FILE" "$REMOTE/daily/" --progress
  if [ "$DAY_OF_WEEK" = "1" ]; then
    rclone copy "$WEEKLY_FILE" "$REMOTE/weekly/" --progress
  fi
elif command -v rsync &>/dev/null; then
  echo "[backup] Copying to remote via rsync: $REMOTE"
  rsync -az "$DAILY_FILE" "$REMOTE/daily/"
  if [ "$DAY_OF_WEEK" = "1" ] && [ -f "${WEEKLY_FILE:-/dev/null}" ]; then
    rsync -az "$WEEKLY_FILE" "$REMOTE/weekly/"
  fi
else
  echo "[backup] WARNING: neither rclone nor rsync found — skipping off-server copy"
  exit 1
fi

echo "[backup] Off-server copy complete"
