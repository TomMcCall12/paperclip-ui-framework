#!/usr/bin/env bash
# Nightly backup (triggered by systemd/paperclip-native-backup.timer at
# 03:17): DB dump, then the data directory and the notes vault, copied to
# <root>/data/backups, then pushed to Google Drive over rclone with
# retry/backoff. Retargeted from deploy/native/scripts/paperclip-backup.sh
# for the single-external-drive ZimaOS layout (TOM-256): no separate HDD,
# and no sudoers drop-in to capture (ZimaOS native installs make no sudo
# changes).
#
# The backup directory includes <root>/env/*.env, which hold plaintext
# secrets (Telegram token, BETTER_AUTH_SECRET, rclone tokens). Restrict who
# can read the Drive folder this lands in.
#
# Usage: paperclip-backup.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIMAOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../../lib/common.sh
source "$ZIMAOS_DIR/../lib/common.sh"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

PAPERCLIP_CURRENT="${PAPERCLIP_CURRENT:-/DATA/.media/External SSD/paperclip-native/current}"
PAPERCLIP_ROOT="$(dirname "$PAPERCLIP_CURRENT")"
PAPERCLIP_HOME="${PAPERCLIP_HOME:-$PAPERCLIP_ROOT/data}"
BACKUP_ROOT="$PAPERCLIP_ROOT/data/backups"
TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
DEST="$BACKUP_ROOT/$TIMESTAMP"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"

log "== DB dump (via paperclipai db:backup, writes into \$PAPERCLIP_HOME/data/backups) =="
run "pnpm paperclipai db:backup" -- bash -c "cd '$PAPERCLIP_CURRENT' && PAPERCLIP_HOME='$PAPERCLIP_HOME' pnpm paperclipai db:backup"

log "== Copy data and vault to $DEST =="
run "Create $DEST" -- mkdir -p "$DEST"
run "Copy data directory" -- copy_tree "$PAPERCLIP_HOME" "$DEST/data"
if [[ -d "$PAPERCLIP_HOME/vault" ]]; then
  run "Copy notes vault" -- copy_tree "$PAPERCLIP_HOME/vault" "$DEST/vault"
else
  log "No vault directory at $PAPERCLIP_HOME/vault, skipping."
fi
run "Copy env files" -- bash -c "mkdir -p '$DEST/configs/env' && cp '$PAPERCLIP_ROOT'/env/*.env '$DEST/configs/env/' 2>/dev/null || true"

if [[ -z "$RCLONE_REMOTE" ]]; then
  log "RCLONE_REMOTE is not set (see env/rclone.env.example); skipping the Drive push."
  log "Local backup complete: $DEST"
  exit 0
fi

log "== Push to Google Drive (retry with backoff) =="
with_retry "rclone sync $DEST -> $RCLONE_REMOTE/$TIMESTAMP" 5 30 -- \
  rclone sync "$DEST" "$RCLONE_REMOTE/$TIMESTAMP" --checksum

log "Backup complete: $DEST (and $RCLONE_REMOTE/$TIMESTAMP)"
