#!/usr/bin/env bash
# Restart paperclip-native.service when it stays down (TOM-686). Started as
# root by paperclip-native-recover.service, which the watchdog's OnFailure=
# starts after a failed /api/health probe; the watchdog's own Telegram
# alert (paperclip-native-alert@) still fires alongside this, unchanged.
#
#   0. Fail closed without flock: the update lock is the only thing that keeps
#      this script from restarting the server (or stopping a build scope)
#      under a running update, so if flock cannot run, do nothing and exit
#      non-zero. The next timer tick retries.
#   1. Skip while paperclip-update.sh holds its lock: the update restarts
#      the server itself and has its own exit safety net.
#   2. Probe again after PAPERCLIP_RECOVER_PROBE_DELAY seconds. The
#      watchdog's failure was the first failed probe; a restart needs two
#      consecutive failures, so a server that answers now is left alone.
#   3. Take the update lock and keep it to the end of the run, so an update
#      cannot start between the last health check and the restart. Under the
#      lock: probe once more, stop any build scope an updater left behind
#      when it was SIGKILLed, and apply the rate limit.
#   4. At most one restart per PAPERCLIP_RECOVER_MIN_INTERVAL seconds
#      (default 15 minutes). A rate-limited run exits non-zero so its own
#      OnFailure= alert says the server is down and was not restarted.
#   5. Restart and wait for /api/health, still holding the lock.
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
  log "[dry-run] would exit non-zero without doing anything if flock cannot run (cannot hold the update lock)"
  log "[dry-run] would skip if $LOCK_FILE is locked (an update is running)"
  log "[dry-run] would probe $HEALTH_URL again after ${PROBE_DELAY}s and stop if it answers"
  log "[dry-run] would then take $LOCK_FILE (skip if an update holds it) and keep it until after the restart's health check; under it: probe once more, stop leftover paperclip-build-*.scope units (not the host tests' paperclip-build-test-*), restart"
  log "[dry-run] would restart $SERVICE at most once per ${MIN_INTERVAL}s (state: $STATE_FILE), then wait for health"
  exit 0
fi

health_ok() {
  curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null 2>&1
}

# Without a working flock this script cannot tell whether an update is
# running, so it must not sweep build scopes or restart the server.
flock_usable() {
  command -v flock >/dev/null 2>&1 && flock --version >/dev/null 2>&1
}

update_running() {
  [[ -e "$LOCK_FILE" ]] || return 1
  ! flock -n "$LOCK_FILE" true
}

# stop_leftover_build_scopes
# An updater that was SIGKILLed leaves its paperclip-build-*.scope running.
# Called only while this script holds the update lock, which proves no
# updater is alive. Best effort: the server comes back even if a scope
# cannot be stopped, but the failure is logged.
stop_leftover_build_scopes() {
  local out a b unit
  out="$(systemctl list-units --all --plain --no-legend --no-pager --type=scope 'paperclip-build-*.scope' 2>/dev/null)" \
    || { log "WARNING: could not list paperclip-build-*.scope units."; return 0; }
  while read -r a b _; do
    case "$a" in
      "●"|"○"|"×"|"*") unit="$b" ;;
      *) unit="$a" ;;
    esac
    [[ "$unit" == paperclip-build-*.scope ]] || continue
    # The host tests' own scopes (paperclip-build-test-*) are not an
    # updater's; a real build scope is paperclip-build-<hex sha>.
    [[ "$unit" != paperclip-build-test-* ]] || continue
    log "Stopping leftover build scope $unit (its updater is gone)."
    systemctl kill --signal=SIGKILL --kill-whom=all "$unit" >/dev/null 2>&1 || true
    systemctl stop "$unit" >/dev/null 2>&1 || true
    # `stop` fails for a scope the kill already removed; ask for the state.
    case "$(systemctl show -p ActiveState --value "$unit" 2>/dev/null || echo unknown)" in
      active|activating|deactivating|reloading|unknown) log "WARNING: could not stop $unit; its processes may still be running." ;;
      *) log "Stopped leftover build scope $unit." ;;
    esac
  done <<<"$out"
  return 0
}

if ! flock_usable; then
  log "ERROR: flock is not available, so this script cannot tell whether an update is running or hold the update lock. Failing closed: no build-scope sweep and no restart of $SERVICE. The next timer tick retries; install util-linux flock if this repeats."
  exit 1
fi

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

# Take the update lock and keep it (fd 8) until this script exits, so an
# updater cannot start between this health re-check and the restart below.
# 8>> creates the file if it is missing and never truncates it.
mkdir -p "$(dirname "$LOCK_FILE")"
exec 8>>"$LOCK_FILE"
if ! flock -n 8; then
  log "An update started while this check waited; it owns the restart. Not restarting."
  exit 0
fi
if health_ok; then
  log "Final probe under the update lock OK: $HEALTH_URL answers. Not restarting."
  exit 0
fi
stop_leftover_build_scopes

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
