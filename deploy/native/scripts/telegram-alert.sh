#!/usr/bin/env bash
# Send a Telegram alert naming the systemd unit that failed. Invoked as
# paperclip-alert@<unit>.service via every OnFailure= in deploy/native/systemd/.
# Token and chat id load from /srv/paperclip/env/telegram.env (EnvironmentFile=
# on the alert unit) -- never hard-coded here.
#
# Usage: telegram-alert.sh [--dry-run] <failed-unit-name>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi
FAILED_UNIT="${1:-unknown-unit}"
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN must be set (see env/telegram.env.example)}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID must be set (see env/telegram.env.example)}"

HOST_LABEL="$(hostname -f 2>/dev/null || hostname)"
MESSAGE="Paperclip native: ${FAILED_UNIT} failed on ${HOST_LABEL} at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

run "Send Telegram alert: $MESSAGE" -- curl -fsS --max-time 10 \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${MESSAGE}"
