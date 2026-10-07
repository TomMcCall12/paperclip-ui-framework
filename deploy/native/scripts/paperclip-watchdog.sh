#!/usr/bin/env bash
# Probe Paperclip's /api/health. A non-zero exit here is what triggers the
# OnFailure=paperclip-alert@%n.service Telegram alert declared on
# paperclip-watchdog.service -- this script does not send Telegram itself.
#
# Usage: paperclip-watchdog.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

PORT="${PORT:-3100}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would curl -fsS --max-time 10 $HEALTH_URL and exit non-zero on failure"
  exit 0
fi

if ! curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null; then
  die "Health check failed: $HEALTH_URL"
fi
log "Health check OK: $HEALTH_URL"
