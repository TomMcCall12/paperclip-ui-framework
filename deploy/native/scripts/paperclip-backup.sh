#!/usr/bin/env bash
# Nightly backup (triggered by systemd/paperclip-backup.timer at 03:17):
# DB dump, then the data directory, the notes vault and configs, copied to
# the HDD, then pushed to Google Drive over rclone with retry/backoff.
#
# The HDD copy includes /srv/paperclip/env/*.env, which hold plaintext
# secrets (Telegram token, BETTER_AUTH_SECRET, rclone tokens). That mirrors
# what the old Hermes backup already did for its own configs; restrict who
# can read the Drive folder this lands in.
#
# Usage: paperclip-backup.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

PAPERCLIP_CURRENT="/srv/paperclip/current"
PAPERCLIP_HOME="${PAPERCLIP_HOME:-/srv/paperclip/data}"
HDD_BACKUP_ROOT="/srv/hdd/backups"
TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
DEST="$HDD_BACKUP_ROOT/$TIMESTAMP"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"

log "== DB dump (via paperclipai db:backup, writes into \$PAPERCLIP_HOME/data/backups) =="
run "pnpm paperclipai db:backup" -- bash -c "cd '$PAPERCLIP_CURRENT' && PAPERCLIP_HOME='$PAPERCLIP_HOME' pnpm paperclipai db:backup"

log "== Copy data, vault and configs to $DEST =="
run "Create $DEST" -- mkdir -p "$DEST"
run "Copy data directory" -- rsync -a "$PAPERCLIP_HOME/" "$DEST/data/"
if [[ -d "$PAPERCLIP_HOME/vault" ]]; then
  run "Copy notes vault" -- rsync -a "$PAPERCLIP_HOME/vault/" "$DEST/vault/"
else
  log "No vault directory at $PAPERCLIP_HOME/vault, skipping."
fi
run "Copy systemd units" -- bash -c "mkdir -p '$DEST/configs/systemd' && cp /etc/systemd/system/paperclip*.service /etc/systemd/system/paperclip*.timer /etc/systemd/system/vault-drive-sync.* '$DEST/configs/systemd/' 2>/dev/null || true"
run "Copy sudoers drop-in" -- bash -c "mkdir -p '$DEST/configs/sudoers.d' && cp /etc/sudoers.d/paperclip '$DEST/configs/sudoers.d/' 2>/dev/null || true"

if [[ -z "$RCLONE_REMOTE" ]]; then
  log "RCLONE_REMOTE is not set (see env/rclone.env.example); skipping the Drive push."
  log "Local HDD backup complete: $DEST"
  exit 0
fi

log "== Push to Google Drive (retry with backoff) =="
with_retry "rclone sync $DEST -> $RCLONE_REMOTE/$TIMESTAMP" 5 30 -- \
  rclone sync "$DEST" "$RCLONE_REMOTE/$TIMESTAMP" --checksum

log "Backup complete: $DEST (and $RCLONE_REMOTE/$TIMESTAMP)"
