#!/usr/bin/env bash
# One-way notes-vault sync to Google Drive (triggered by
# systemd/vault-drive-sync.timer every 15 minutes). One-way: Drive is a
# mirror of the vault, never the other way around, per TOM-130's plan
# ("keep it one-way unless Tom asks otherwise").
#
# Usage: vault-drive-sync.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

VAULT_ROOT="${VAULT_ROOT:-/srv/paperclip/data/vault}"
RCLONE_VAULT_REMOTE="${RCLONE_VAULT_REMOTE:-}"

if [[ "$DRY_RUN" != "1" && ! -d "$VAULT_ROOT" ]]; then
  die "Vault root $VAULT_ROOT does not exist."
fi
if [[ -z "$RCLONE_VAULT_REMOTE" ]]; then
  die "RCLONE_VAULT_REMOTE is not set (see env/rclone.env.example)."
fi

with_retry "rclone sync $VAULT_ROOT -> $RCLONE_VAULT_REMOTE (one-way)" 3 15 -- \
  rclone sync "$VAULT_ROOT" "$RCLONE_VAULT_REMOTE" --checksum

log "Vault sync complete: $VAULT_ROOT -> $RCLONE_VAULT_REMOTE"
