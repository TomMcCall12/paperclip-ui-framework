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
# Self-contained on purpose (no lib/common.sh): it lives in the recovery
# path outside every release.
#
# Environment: PAPERCLIP_OOM_SERVER_ADJ (-500), PAPERCLIP_OOM_AGENT_ADJ (0),
# PAPERCLIP_OOM_GUARD_INTERVAL (5), PAPERCLIP_OOM_GUARD_ONCE (unset; set to
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
INTERVAL="${PAPERCLIP_OOM_GUARD_INTERVAL:-5}"
CGROUP_ROOT="${PAPERCLIP_CGROUP_ROOT:-/sys/fs/cgroup}"
PROC_ROOT="${PAPERCLIP_PROC_ROOT:-/proc}"

if [[ "${1:-}" == "--dry-run" ]]; then
  log "[dry-run] every ${INTERVAL}s: set oom_score_adj=$SERVER_ADJ on $SERVICE's main process and embedded Postgres; raise every other process in its cgroup to at least $AGENT_ADJ"
  exit 0
fi

# is_server_process <pid> <main-pid>
is_server_process() {
  local pid="$1" main="$2" exe
  [[ "$pid" == "$main" ]] && return 0
  exe="$(readlink "$PROC_ROOT/$pid/exe" 2>/dev/null || true)"
  [[ "$exe" == */@embedded-postgres/*/bin/postgres ]]
}

set_adj() {
  local pid="$1" value="$2"
  printf '%s\n' "$value" >"$PROC_ROOT/$pid/oom_score_adj" 2>/dev/null
}

last_main=""
guard_pass() {
  local main cg pid cur comm raised=""
  main="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
  cg="$(systemctl show -p ControlGroup --value "$SERVICE" 2>/dev/null || true)"
  [[ "$main" =~ ^[0-9]+$ && "$main" -gt 0 && -n "$cg" && -r "$CGROUP_ROOT$cg/cgroup.procs" ]] || return 0
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    cur="$(cat "$PROC_ROOT/$pid/oom_score_adj" 2>/dev/null)" || continue
    if is_server_process "$pid" "$main"; then
      [[ "$cur" == "$SERVER_ADJ" ]] || set_adj "$pid" "$SERVER_ADJ" || true
    elif ((cur < AGENT_ADJ)); then
      if set_adj "$pid" "$AGENT_ADJ"; then
        comm="$(cat "$PROC_ROOT/$pid/comm" 2>/dev/null || echo '?')"
        raised+=" $comm($pid)"
      fi
    fi
  done <"$CGROUP_ROOT$cg/cgroup.procs"
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
