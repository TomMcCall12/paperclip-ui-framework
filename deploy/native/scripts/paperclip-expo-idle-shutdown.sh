#!/usr/bin/env bash
# Stop idle Expo dev servers (and their ngrok tunnels) running inside
# paperclip-native.service's cgroup.
#
# Why this exists (TOM-510): under Hermes/Docker, an Expo shutdown safeguard
# killed idle `expo start` processes. That safeguard never moved to native
# Paperclip. An `expo start --dev-client --lan --port 8081` started by Jarvis
# for TOM-460 ran for 14 hours after its task finished, holding ~1.1GB RAM and
# ~1.1GB swap and pushing total swap past the 2048MB critical threshold
# (SWAP_FAIL_MB in check-resource-pressure.sh), which failed the daily digest.
#
# This script finds Expo dev-server processes (and any ngrok child they
# spawned) in paperclip-native.service's own cgroup and stops the ones that
# are either:
#   - older than MAX_AGE_SECONDS (default 4h), or
#   - started by a Paperclip task (PAPERCLIP_TASK_ID in /proc/<pid>/environ)
#     whose issue status is now "done" or "cancelled".
#
# It never touches paperclip-native.service's own MainPID, and only ever
# matches a process whose own argv names an Expo CLI invocation (an argv
# token basename "expo", or a token under an "@expo/cli/" path, together with
# a separate "start" argument) -- never a substring match over the joined
# command line, which would also match a shell wrapper whose argv happens to
# quote the text "expo" and "start" without running either. A `tailscale
# serve` preview-publishing process has neither an "expo" nor an "ngrok" argv
# token, so it can never match. Every decision -- stopped or left alone -- is
# logged to <root>/logs/expo-idle-shutdown.log with pid, age and task id.
#
# Usage: paperclip-expo-idle-shutdown.sh [--dry-run]
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"
# Prefer PAPERCLIP_NATIVE_ROOT (set by the systemd unit) over walking up from
# SCRIPT_DIR: this script's own directory is only two levels under the real
# root when the recovery base happens to be <root>/recovery/scripts. If
# /usr/local/lib/paperclip was writable at install time and became the
# recovery base instead, that walk lands on /usr/local/lib, not the real
# root -- breaking the logs/, `current` symlink and toolchain lookups below.
ROOT_DIR="${PAPERCLIP_NATIVE_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

MAX_AGE_SECONDS="${EXPO_IDLE_MAX_AGE_SECONDS:-14400}"   # 4h, per the issue
UNIT="${EXPO_IDLE_UNIT:-paperclip-native.service}"
LOG_FILE="${EXPO_IDLE_LOG_FILE:-$ROOT_DIR/logs/expo-idle-shutdown.log}"
mkdir -p "$(dirname "$LOG_FILE")"

logf() {
  # Logs to both the journal (via log(), stderr) and the dedicated log file
  # the issue asks for.
  log "$*"
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$LOG_FILE"
}

# resolve_pg_module
# Finds the `pg` package shipped inside the live release's node_modules, by
# globbing node_modules/.pnpm/pg@*/node_modules/pg rather than hardcoding a
# version, since the release the symlink points at changes on every deploy.
resolve_pg_module() {
  local current pg_dir
  current="$(readlink -f "$ROOT_DIR/current" 2>/dev/null || true)"
  [[ -n "$current" && -d "$current" ]] || return 1
  pg_dir="$(compgen -G "$current/node_modules/.pnpm/pg@*/node_modules/pg" | head -n1)"
  [[ -n "$pg_dir" ]] || return 1
  printf '%s\n' "$pg_dir"
}

NODE_BIN="$ROOT_DIR/toolchain/node/bin/node"
PG_MODULE="$(resolve_pg_module || true)"

# issue_status <task-id>
# Reads an issue's status straight from the embedded Postgres the live
# release already uses (127.0.0.1:54329, db/user/password all "paperclip" --
# bound to loopback only, the same fixed, non-secret default documented in
# packages/db/src/test-embedded-postgres.ts). Prints the status, or nothing
# if the lookup could not be made (missing node/pg, DB unreachable, unknown
# id) -- callers must treat "nothing" as "unknown", never as "done".
issue_status() {
  local task_id="$1"
  [[ -n "$NODE_BIN" && -x "$NODE_BIN" && -n "$PG_MODULE" ]] || return 1
  "$NODE_BIN" -e '
    const { Client } = require(process.argv[1]);
    const c = new Client({ host: "127.0.0.1", port: 54329, user: "paperclip", password: "paperclip", database: "paperclip" });
    c.connect()
      .then(() => c.query("select status from issues where id = $1", [process.argv[2]]))
      .then((r) => { if (r.rows[0]) process.stdout.write(r.rows[0].status); })
      .catch(() => {})
      .finally(() => c.end());
  ' "$PG_MODULE" "$task_id" 2>/dev/null
}

# pid_task_id <pid>
# Reads PAPERCLIP_TASK_ID out of /proc/<pid>/environ (NUL-separated). Prints
# nothing if the pid is gone or the var is not set.
pid_task_id() {
  local pid="$1"
  tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | sed -n 's/^PAPERCLIP_TASK_ID=//p' | head -n1
}

# pid_cmdline <pid>
# Joined form, for logging only -- never for matching (see pid_argv below).
pid_cmdline() {
  local pid="$1"
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null
}

# pid_argv <pid>
# Reads /proc/<pid>/cmdline as its real NUL-separated argv into the global
# array ARGV. Matching must walk this array, one real argument per element,
# never a joined/collapsed string: a joined string turns any process whose
# *text* happens to contain the words "expo" and "start" (e.g. a shell
# wrapper whose single argv element is a multi-line script that quotes an
# `expo start ...` command without running it) into a false match.
ARGV=()
pid_argv() {
  local pid="$1"
  ARGV=()
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  while IFS= read -r -d '' tok; do ARGV+=("$tok"); done < "/proc/$pid/cmdline" 2>/dev/null
  [[ "${#ARGV[@]}" -gt 0 ]]
}

# pid_age_seconds <pid>
pid_age_seconds() {
  local pid="$1"
  ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' '
}

# pid_ppid <pid>
pid_ppid() {
  awk '{print $4}' "/proc/$1/stat" 2>/dev/null
}

# argv_has_expo_start
# True if ARGV (set by pid_argv) names an actual Expo CLI invocation: some
# token's basename is exactly "expo" (covers node_modules/.bin/expo and a
# bare `expo` on PATH) or contains the @expo/cli package path, AND some
# other token is the exact argument "start". Per-token basename/equality
# checks, not substring-anywhere, so a token that merely contains the
# letters "expo" or "start" inside a longer path or string can't match.
argv_has_expo_start() {
  local tok base has_expo=0 has_start=0
  for tok in "${ARGV[@]}"; do
    base="${tok##*/}"
    if [[ "$base" == "expo" || "$tok" == *"/@expo/cli/"* ]]; then
      has_expo=1
    fi
    if [[ "$tok" == "start" ]]; then
      has_start=1
    fi
  done
  [[ "$has_expo" == "1" && "$has_start" == "1" ]]
}

# argv_has_ngrok
# True if ARGV names an ngrok binary: some token's basename is exactly
# "ngrok" (ngrok ships as a single static binary with that exact name).
argv_has_ngrok() {
  local tok base
  for tok in "${ARGV[@]}"; do
    base="${tok##*/}"
    [[ "$base" == "ngrok" ]] && return 0
  done
  return 1
}

CG_PATH="$(systemctl show "$UNIT" -p ControlGroup --value 2>/dev/null)"
if [[ -z "$CG_PATH" ]]; then
  die "Could not resolve ControlGroup for $UNIT"
fi
MAIN_PID="$(systemctl show "$UNIT" -p MainPID --value 2>/dev/null)"

PROCS_FILE="/sys/fs/cgroup${CG_PATH}/cgroup.procs"
if [[ ! -r "$PROCS_FILE" ]]; then
  die "Could not read cgroup.procs at $PROCS_FILE"
fi

mapfile -t ALL_PIDS <"$PROCS_FILE"

declare -A EXPO_PIDS=()
for pid in "${ALL_PIDS[@]}"; do
  [[ "$pid" == "$MAIN_PID" ]] && continue
  pid_argv "$pid" || continue
  if argv_has_expo_start; then
    EXPO_PIDS["$pid"]="$(pid_cmdline "$pid")"
  fi
done

# ngrok tunnels spawned by a matched Expo process: walk every other cgroup
# pid's ppid chain and attach it only if an ancestor is a matched Expo pid.
# This is what keeps an unrelated ngrok (if one were ever run here for some
# other reason) out of scope, and keeps `tailscale serve` previews (which
# have no Expo ancestor and no "expo"/"ngrok" argv token at all) untouched
# twice over.
declare -A STOP_PIDS=()
for pid in "${!EXPO_PIDS[@]}"; do
  STOP_PIDS["$pid"]="expo:${EXPO_PIDS[$pid]}"
done
for pid in "${ALL_PIDS[@]}"; do
  [[ "$pid" == "$MAIN_PID" ]] && continue
  [[ -n "${EXPO_PIDS[$pid]:-}" ]] && continue
  pid_argv "$pid" || continue
  argv_has_ngrok || continue
  cmdline="$(pid_cmdline "$pid")"
  ancestor="$pid"
  for _ in 1 2 3 4 5 6 7 8; do
    ancestor="$(pid_ppid "$ancestor")"
    [[ -n "$ancestor" && "$ancestor" != "0" ]] || break
    if [[ -n "${EXPO_PIDS[$ancestor]:-}" ]]; then
      STOP_PIDS["$pid"]="ngrok (child of expo pid $ancestor):$cmdline"
      break
    fi
  done
done

if [[ "${#STOP_PIDS[@]}" -eq 0 ]]; then
  logf "No Expo dev server or ngrok tunnel found in ${UNIT}'s cgroup; nothing to check."
  exit 0
fi

for pid in "${!STOP_PIDS[@]}"; do
  [[ -d "/proc/$pid" ]] || continue
  age="$(pid_age_seconds "$pid")"
  [[ -n "$age" ]] || age="unknown"
  task_id="$(pid_task_id "$pid")"
  [[ -n "$task_id" ]] || task_id="unknown"

  reason=""
  if [[ "$task_id" != "unknown" ]]; then
    status="$(issue_status "$task_id")"
    if [[ "$status" == "done" || "$status" == "cancelled" ]]; then
      reason="starting task $task_id is $status"
    fi
  fi
  if [[ -z "$reason" && "$age" != "unknown" && "$age" -ge "$MAX_AGE_SECONDS" ]]; then
    reason="age ${age}s >= ${MAX_AGE_SECONDS}s idle limit"
  fi

  if [[ -z "$reason" ]]; then
    logf "Leaving alone: pid=$pid age=${age}s task=$task_id (${STOP_PIDS[$pid]})"
    continue
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    logf "[dry-run] would stop: pid=$pid age=${age}s task=$task_id reason=\"$reason\" (${STOP_PIDS[$pid]})"
    continue
  fi

  logf "Stopping: pid=$pid age=${age}s task=$task_id reason=\"$reason\" (${STOP_PIDS[$pid]})"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    [[ -d "/proc/$pid" ]] || break
    sleep 1
  done
  if [[ -d "/proc/$pid" ]]; then
    logf "pid=$pid still alive 5s after SIGTERM, sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
  fi
done
