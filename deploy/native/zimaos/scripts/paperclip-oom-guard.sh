#!/usr/bin/env bash
# Keep the live Paperclip server, not its agent runs, out of the OOM
# killer's way (TOM-686). Runs as root under paperclip-native-oom-guard.service,
# which paperclip-native.service pulls in (Wants=) and stops with it
# (PartOf=).
#
# Every PAPERCLIP_OOM_GUARD_INTERVAL seconds it walks the processes in
# paperclip-native.service's cgroup:
#   - the server's main process and its embedded Postgres processes get
#     oom_score_adj PAPERCLIP_OOM_SERVER_ADJ (default -500, the same as
#     dockerd and below 0, where tailscaled and NetworkManager run);
#   - every other process -- agent runs, their tools, git -- that has a
#     lower value than PAPERCLIP_OOM_AGENT_ADJ (default 0) is raised to it.
#
# Why a loop and not ExecStartPost=+ alone: agent runs start inside this
# same unit, forked by the server, and a child inherits its parent's
# oom_score_adj at fork. Protecting only the main process once would make
# every later agent run just as protected as the server, i.e. more
# protected than Tailscale and networking. This loop gives each new child
# the agent value within one interval. If this guard is not running, nothing
# is protected (everything stays at 0), which is the safe failure.
#
# The interval is 0.2s, not seconds: a new agent process holds the server's
# -500 only until the next pass, which is a fresh fork that has not yet
# allocated anything, not the several seconds in which an agent could load
# a model's worth of memory while more protected than the network stack.
# A pass reads /proc with shell builtins only (no per-process fork), so it
# costs a few milliseconds.
#
# Self-contained on purpose (no lib/common.sh): it lives in the recovery
# path outside every release.
#
# Environment: PAPERCLIP_OOM_SERVER_ADJ (-500), PAPERCLIP_OOM_AGENT_ADJ (0),
# PAPERCLIP_OOM_GUARD_INTERVAL (0.2), PAPERCLIP_OOM_GUARD_ONCE (unset; set to
# 1 to do a single pass and exit).
#
# Usage: paperclip-oom-guard.sh [--dry-run]
set -euo pipefail

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

SERVICE="paperclip-native.service"
SERVER_ADJ="${PAPERCLIP_OOM_SERVER_ADJ:--500}"
AGENT_ADJ="${PAPERCLIP_OOM_AGENT_ADJ:-0}"
INTERVAL="${PAPERCLIP_OOM_GUARD_INTERVAL:-0.2}"
CGROUP_ROOT="${PAPERCLIP_CGROUP_ROOT:-/sys/fs/cgroup}"
PROC_ROOT="${PAPERCLIP_PROC_ROOT:-/proc}"

if [[ "${1:-}" == "--dry-run" ]]; then
  log "[dry-run] every ${INTERVAL}s: set oom_score_adj=$SERVER_ADJ on $SERVICE's main process and embedded Postgres; raise every other process in its cgroup to at least $AGENT_ADJ"
  exit 0
fi

# is_embedded_postgres <pid>
is_embedded_postgres() {
  local exe
  exe="$(readlink "$PROC_ROOT/$1/exe" 2>/dev/null || true)"
  [[ "$exe" == */@embedded-postgres/*/bin/postgres ]]
}

set_adj() {
  local pid="$1" value="$2"
  printf '%s\n' "$value" >"$PROC_ROOT/$pid/oom_score_adj" 2>/dev/null
}

# pid_key <pid>: sets PID_KEY to pid plus start time, so a reused pid is not
# mistaken for the process it replaced. Shell builtins only (no subshell).
pid_key() {
  local pid="$1" line rest
  PID_KEY="$pid:0"
  { read -r line <"$PROC_ROOT/$pid/stat"; } 2>/dev/null || return 0
  rest="${line##*) }"
  # shellcheck disable=SC2086 # split on purpose: starttime is field 22 of stat
  set -- "$pid" $rest
  PID_KEY="$pid:${21:-0}"
}

# A pass runs every INTERVAL (0.2s): the cgroup's pid list is read each time,
# but `systemctl show` only every SERVICE_REFRESH passes, and a pid is
# checked for being embedded Postgres once (readlink is a fork).
declare -A is_pg=()
last_main=""
main=""
cg=""
pass_no=0
SERVICE_REFRESH=25
guard_pass() {
  local pid cur comm raised="" key
  local -A seen=()
  if ((pass_no % SERVICE_REFRESH == 0)) || [[ -z "$cg" ]]; then
    main="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
    cg="$(systemctl show -p ControlGroup --value "$SERVICE" 2>/dev/null || true)"
  fi
  pass_no=$((pass_no + 1))
  [[ "$main" =~ ^[0-9]+$ && "$main" -gt 0 && -n "$cg" && -r "$CGROUP_ROOT$cg/cgroup.procs" ]] || { cg=""; return 0; }
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    { read -r cur <"$PROC_ROOT/$pid/oom_score_adj"; } 2>/dev/null || continue
    [[ "$cur" =~ ^-?[0-9]+$ ]] || continue
    if [[ "$pid" == "$main" ]]; then
      [[ "$cur" == "$SERVER_ADJ" ]] || set_adj "$pid" "$SERVER_ADJ" || true
      continue
    fi
    pid_key "$pid"
    key="$PID_KEY"
    seen["$key"]=1
    if [[ -z "${is_pg[$key]:-}" ]]; then
      if is_embedded_postgres "$pid"; then is_pg["$key"]=1; else is_pg["$key"]=0; fi
    fi
    if [[ "${is_pg[$key]}" == "1" ]]; then
      [[ "$cur" == "$SERVER_ADJ" ]] || set_adj "$pid" "$SERVER_ADJ" || true
    elif ((cur < AGENT_ADJ)); then
      if set_adj "$pid" "$AGENT_ADJ"; then
        { read -r comm <"$PROC_ROOT/$pid/comm"; } 2>/dev/null || comm="?"
        raised+=" $comm($pid)"
      fi
    fi
  done <"$CGROUP_ROOT$cg/cgroup.procs"
  for key in "${!is_pg[@]}"; do
    [[ -n "${seen[$key]:-}" ]] || unset 'is_pg[$key]'
  done
  if [[ "$main" != "$last_main" ]]; then
    log "Protecting $SERVICE main process $main and its embedded Postgres at oom_score_adj=$SERVER_ADJ; other processes in the unit are kept at >= $AGENT_ADJ."
    last_main="$main"
  fi
  if [[ -n "$raised" ]]; then
    log "Raised to oom_score_adj=$AGENT_ADJ (inherited the server's value at fork):$raised"
  fi
  return 0
}

if [[ "${PAPERCLIP_OOM_GUARD_ONCE:-}" == "1" ]]; then
  guard_pass
  exit 0
fi
while :; do
  guard_pass
  sleep "$INTERVAL"
done
