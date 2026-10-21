#!/usr/bin/env bash
# Restart paperclip-native.service in the quiet early-morning hours when it
# has grown too big or run too long (TOM-690). Started as root once a day by
# paperclip-native-quiet-restart.timer.
#
# Why: on 21 Oct swap was 99% full before the rebuild started; the server
# process had run for 4 days, and an earlier run peaked at 10 GB. A restart
# gives that memory back. It is skipped when it is not needed, so most
# nights do nothing.
#
#   1. Skip while paperclip-update.sh holds its lock.
#   2. Restart only if one of these is true:
#        - the unit's anonymous memory plus swap is at least
#          PAPERCLIP_QUIET_RESTART_MEM_MB (default 6144);
#        - host swap use is at least PAPERCLIP_QUIET_RESTART_SWAP_PCT
#          percent (default 50);
#        - the unit has run for PAPERCLIP_QUIET_RESTART_MAX_DAYS days or
#          more (default 3).
#   3. Wait for no agent run: every process in the unit other than the
#      server's main process and its embedded Postgres counts as agent work.
#      Check every PAPERCLIP_QUIET_RESTART_POLL seconds (default 60), for at
#      most PAPERCLIP_QUIET_RESTART_WAIT seconds (default 5400). Still busy
#      then: skip tonight, never kill a run.
#   4. Take the update lock (skip if an update started), check for agent
#      work once more, restart, and wait for /api/health. A server that does
#      not come back makes this exit non-zero, so its OnFailure= alert fires
#      (and the watchdog's recovery unit takes over).
#
# Every decision is appended to <root>/logs/quiet-restart.log.
#
# Self-contained on purpose (no lib/common.sh): it lives in the recovery
# path outside every release.
#
# Environment: PAPERCLIP_NATIVE_ROOT (required), PORT (env file),
# PAPERCLIP_QUIET_RESTART_MEM_MB, _SWAP_PCT, _MAX_DAYS, _POLL, _WAIT,
# PAPERCLIP_QUIET_RESTART_HEALTH_ATTEMPTS (24), _HEALTH_DELAY (5). Test
# hooks: PAPERCLIP_QUIET_RESTART_SERVICE, PAPERCLIP_CGROUP_ROOT,
# PAPERCLIP_PROC_ROOT, PAPERCLIP_MEMINFO_FILE, PAPERCLIP_UPTIME_FILE,
# PAPERCLIP_FLOCK_CMD (flock).
#
# Usage: paperclip-quiet-restart.sh [--dry-run]
set -euo pipefail

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

ROOT="${PAPERCLIP_NATIVE_ROOT:?PAPERCLIP_NATIVE_ROOT must be set (see paperclip-native-quiet-restart.service)}"
PORT="${PORT:-3100}"
SERVICE="${PAPERCLIP_QUIET_RESTART_SERVICE:-paperclip-native.service}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
MEM_MB="${PAPERCLIP_QUIET_RESTART_MEM_MB:-6144}"
SWAP_PCT="${PAPERCLIP_QUIET_RESTART_SWAP_PCT:-50}"
MAX_DAYS="${PAPERCLIP_QUIET_RESTART_MAX_DAYS:-3}"
POLL="${PAPERCLIP_QUIET_RESTART_POLL:-60}"
WAIT="${PAPERCLIP_QUIET_RESTART_WAIT:-5400}"
HEALTH_ATTEMPTS="${PAPERCLIP_QUIET_RESTART_HEALTH_ATTEMPTS:-24}"
HEALTH_DELAY="${PAPERCLIP_QUIET_RESTART_HEALTH_DELAY:-5}"
CGROUP_ROOT="${PAPERCLIP_CGROUP_ROOT:-/sys/fs/cgroup}"
PROC_ROOT="${PAPERCLIP_PROC_ROOT:-/proc}"
MEMINFO_FILE="${PAPERCLIP_MEMINFO_FILE:-/proc/meminfo}"
UPTIME_FILE="${PAPERCLIP_UPTIME_FILE:-/proc/uptime}"
LOCK_FILE="$ROOT/logs/.paperclip-update.lock"
RESTART_LOG="$ROOT/logs/quiet-restart.log"
FLOCK="${PAPERCLIP_FLOCK_CMD:-flock}"

for v in MEM_MB SWAP_PCT MAX_DAYS POLL WAIT HEALTH_ATTEMPTS HEALTH_DELAY; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || { log "ERROR: $v must be a whole number (got: ${!v})"; exit 2; }
done

if [[ "${1:-}" == "--dry-run" ]]; then
  log "[dry-run] would skip if $LOCK_FILE is locked (an update is running)"
  log "[dry-run] would restart $SERVICE only if its memory+swap >= ${MEM_MB}MB, host swap >= ${SWAP_PCT}%, or it has run >= ${MAX_DAYS} days"
  log "[dry-run] would first wait (up to ${WAIT}s, every ${POLL}s) until no agent run is in the unit, then take $LOCK_FILE, restart and wait for $HEALTH_URL"
  exit 0
fi

record() {
  log "$*"
  mkdir -p "$ROOT/logs"
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$RESTART_LOG" 2>/dev/null \
    || log "WARNING: could not append to $RESTART_LOG"
}

health_ok() {
  curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null 2>&1
}

update_running() {
  [[ -e "$LOCK_FILE" ]] || return 1
  ! "$FLOCK" -n "$LOCK_FILE" true
}

# meminfo_mb <key>: a /proc/meminfo field in MB (0 if missing).
meminfo_mb() {
  local key="$1" k v _unit
  while read -r k v _unit; do
    if [[ "$k" == "$key:" ]]; then echo $((v / 1024)); return 0; fi
  done <"$MEMINFO_FILE"
  echo 0
}

MAIN="" CG=""
read_unit() {
  MAIN="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
  CG="$(systemctl show -p ControlGroup --value "$SERVICE" 2>/dev/null || true)"
}

# unit_memory_mb: anonymous memory plus swap of the unit's cgroup. Page
# cache is left out on purpose: the kernel gives it back by itself.
unit_memory_mb() {
  local k v anon=0 swap=0
  while read -r k v; do
    [[ "$k" == "anon" ]] && { anon="$v"; break; }
  done <"$CGROUP_ROOT$CG/memory.stat"
  { read -r swap <"$CGROUP_ROOT$CG/memory.swap.current"; } 2>/dev/null || swap=0
  [[ "$swap" =~ ^[0-9]+$ ]] || swap=0
  echo $(((anon + swap) / 1024 / 1024))
}

# agent_work: prints "comm(pid)" for each process in the unit that is not
# the server's main process or embedded Postgres. Empty means idle.
agent_work() {
  local pid exe comm out="" n=0
  while read -r pid; do
    [[ -n "$pid" && "$pid" != "$MAIN" ]] || continue
    exe="$(readlink "$PROC_ROOT/$pid/exe" 2>/dev/null || true)"
    [[ "$exe" == */@embedded-postgres/*/bin/postgres ]] && continue
    # A pid that ended between the list and here is not work.
    { read -r comm <"$PROC_ROOT/$pid/comm"; } 2>/dev/null || continue
    n=$((n + 1))
    ((n <= 10)) && out+=" $comm($pid)"
  done <"$CGROUP_ROOT$CG/cgroup.procs"
  ((n > 10)) && out+=" and $((n - 10)) more"
  printf '%s' "${out# }"
}

# Fail closed: a restart is only ever done while holding the update lock.
if ! command -v "$FLOCK" >/dev/null 2>&1; then
  record "ERROR: $FLOCK is not installed, so the update lock cannot be held during a restart. Not restarting."
  exit 1
fi
if update_running; then
  log "paperclip-update.sh holds $LOCK_FILE; an update is running. Not restarting tonight."
  exit 0
fi

read_unit
unit_running() {
  [[ "$MAIN" =~ ^[0-9]+$ && "$MAIN" -gt 0 && -n "$CG" && -r "$CGROUP_ROOT$CG/cgroup.procs" ]]
}
if ! unit_running; then
  log "$SERVICE is not running (MainPID=$MAIN); nothing to restart. The watchdog and its recovery unit handle a down server."
  exit 0
fi

unit_mb="$(unit_memory_mb)"
swap_total="$(meminfo_mb SwapTotal)"
swap_free="$(meminfo_mb SwapFree)"
swap_used_pct=0
((swap_total > 0)) && swap_used_pct=$(((swap_total - swap_free) * 100 / swap_total))
# How long the unit has run: host uptime minus the unit's start, both on the
# monotonic clock (no time-zone or clock-change surprises).
started_us="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$SERVICE" 2>/dev/null || echo 0)"
[[ "$started_us" =~ ^[0-9]+$ ]] || started_us=0
host_up=0
{ read -r host_up _ <"$UPTIME_FILE"; } 2>/dev/null || true
host_up="${host_up%%.*}"
[[ "$host_up" =~ ^[0-9]+$ ]] || host_up=0
unit_up=$((host_up - started_us / 1000000))
((unit_up < 0)) && unit_up=0
up_days=$((unit_up / 86400))

reasons=()
((unit_mb >= MEM_MB)) && reasons+=("its memory and swap are ${unit_mb}MB (limit ${MEM_MB}MB)")
((swap_used_pct >= SWAP_PCT)) && reasons+=("host swap is ${swap_used_pct}% used (limit ${SWAP_PCT}%)")
((up_days >= MAX_DAYS)) && reasons+=("it has run for ${up_days} days (limit ${MAX_DAYS})")
if [[ ${#reasons[@]} -eq 0 ]]; then
  record "Not needed: $SERVICE uses ${unit_mb}MB, host swap ${swap_used_pct}% used, up ${up_days} day(s)."
  exit 0
fi
why="$(printf '%s; ' "${reasons[@]}")"
why="${why%; }"

waited=0
while :; do
  busy="$(agent_work)"
  [[ -z "$busy" ]] && break
  if ((waited >= WAIT)); then
    record "Skipped: restart needed ($why), but agent work was still running after ${waited}s: $busy. Trying again tomorrow."
    exit 0
  fi
  log "Restart needed ($why); waiting for agent work to finish: $busy"
  sleep "$POLL"
  waited=$((waited + POLL))
  read_unit
  if ! unit_running; then
    record "Skipped: $SERVICE stopped while this waited (MainPID=$MAIN). The watchdog and its recovery unit handle a down server."
    exit 0
  fi
done

# Hold the update lock (fd 8) until this script exits, so an update cannot
# start between the last check and the restart. 8>> never truncates.
exec 8>>"$LOCK_FILE"
if ! "$FLOCK" -n 8; then
  log "An update started while this waited; it owns the restart. Not restarting tonight."
  exit 0
fi
read_unit
if ! unit_running; then
  record "Skipped: $SERVICE stopped at the last moment (MainPID=$MAIN)."
  exit 0
fi
busy="$(agent_work)"
if [[ -n "$busy" ]]; then
  record "Skipped: agent work started at the last moment: $busy. Trying again tomorrow."
  exit 0
fi

record "Restarting $SERVICE in the quiet window: $why."
systemctl restart "$SERVICE"
for ((i = 1; i <= HEALTH_ATTEMPTS; i++)); do
  if health_ok; then
    record "Restarted: $HEALTH_URL answers (attempt $i/$HEALTH_ATTEMPTS)."
    exit 0
  fi
  sleep "$HEALTH_DELAY"
done
record "ERROR: $SERVICE was restarted but $HEALTH_URL does not answer."
exit 1
