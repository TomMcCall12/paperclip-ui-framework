#!/usr/bin/env bash
# Restart paperclip-native.service when it stays down (TOM-686). Started as
# root by paperclip-native-recover.service, which the watchdog's OnFailure=
# starts after a failed /api/health probe; the watchdog's own Telegram
# alert (paperclip-native-alert@) still fires alongside this, unchanged.
#
#   1. Skip while paperclip-update.sh holds its lock: the update restarts
#      the server itself and has its own exit safety net.
#   2. Probe again after PAPERCLIP_RECOVER_PROBE_DELAY seconds. The
#      watchdog's failure was the first failed probe; a restart needs two
#      consecutive failures, so a server that answers now is left alone.
#   3. At most one restart per PAPERCLIP_RECOVER_MIN_INTERVAL seconds
#      (default 15 minutes). A rate-limited run exits non-zero so its own
#      OnFailure= alert says the server is down and was not restarted.
#   4. Restart and wait for /api/health.
#
# Self-contained on purpose (no lib/common.sh): it lives in the recovery
# path outside every release, and must keep working whichever release is
# current, including one rolled back to that predates this script.
#
# Environment: PAPERCLIP_NATIVE_ROOT (required), PORT (from the env file),
# PAPERCLIP_RECOVER_PROBE_DELAY (30), PAPERCLIP_RECOVER_MIN_INTERVAL (900),
# PAPERCLIP_RECOVER_HEALTH_ATTEMPTS (24), PAPERCLIP_RECOVER_HEALTH_DELAY (5).
#
# Usage: paperclip-recover.sh [--dry-run]
set -euo pipefail

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

ROOT="${PAPERCLIP_NATIVE_ROOT:?PAPERCLIP_NATIVE_ROOT must be set (see paperclip-native-recover.service)}"
PORT="${PORT:-3100}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
SERVICE="paperclip-native.service"
LOCK_FILE="$ROOT/logs/.paperclip-update.lock"
STATE_FILE="$ROOT/logs/.paperclip-recover.last-restart"
PROBE_DELAY="${PAPERCLIP_RECOVER_PROBE_DELAY:-30}"
MIN_INTERVAL="${PAPERCLIP_RECOVER_MIN_INTERVAL:-900}"
HEALTH_ATTEMPTS="${PAPERCLIP_RECOVER_HEALTH_ATTEMPTS:-24}"
HEALTH_DELAY="${PAPERCLIP_RECOVER_HEALTH_DELAY:-5}"

if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would skip if $LOCK_FILE is locked (an update is running)"
  log "[dry-run] would probe $HEALTH_URL again after ${PROBE_DELAY}s and stop if it answers"
  log "[dry-run] would restart $SERVICE at most once per ${MIN_INTERVAL}s (state: $STATE_FILE), then wait for health"
  exit 0
fi

health_ok() {
  curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null 2>&1
}

update_running() {
  [[ -e "$LOCK_FILE" ]] || return 1
  if ! command -v flock >/dev/null 2>&1; then
    log "WARNING: flock is not installed; cannot tell whether an update is running."
    return 1
  fi
  ! flock -n "$LOCK_FILE" true
}

if update_running; then
  log "paperclip-update.sh holds $LOCK_FILE; an update is running and owns the restart. Not restarting."
  exit 0
fi

log "The watchdog's health probe failed; probing $HEALTH_URL again in ${PROBE_DELAY}s."
sleep "$PROBE_DELAY"
if health_ok; then
  log "Second probe OK: $HEALTH_URL answers. Not restarting."
  exit 0
fi
log "Second consecutive probe failed: $HEALTH_URL."

now="$(date +%s)"
last=0
if [[ -r "$STATE_FILE" ]]; then
  last="$(head -n1 "$STATE_FILE" 2>/dev/null || echo 0)"
  [[ "$last" =~ ^[0-9]+$ ]] || last=0
fi
if ((now - last < MIN_INTERVAL)); then
  log "ERROR: $SERVICE is down, but it was restarted $((now - last))s ago and this unit restarts it at most once per ${MIN_INTERVAL}s. Not restarting; needs a person."
  exit 1
fi

if update_running; then
  log "An update started while this check waited; it owns the restart. Not restarting."
  exit 0
fi

printf '%s\n' "$now" >"$STATE_FILE"
log "Restarting $SERVICE after two consecutive failed health probes."
systemctl restart "$SERVICE"
for ((i = 1; i <= HEALTH_ATTEMPTS; i++)); do
  if health_ok; then
    log "Recovered: $HEALTH_URL answers (attempt $i/$HEALTH_ATTEMPTS)."
    exit 0
  fi
  sleep "$HEALTH_DELAY"
done
log "ERROR: $SERVICE restarted but $HEALTH_URL still does not answer."
exit 1
