#!/usr/bin/env bash
# Shared helpers for the deploy/native scripts: logging, dry-run gating and
# a couple of guards (root, command presence) every script here needs.
# Source it; do not execute it directly.

# DRY_RUN must already be set (0 or 1) by the sourcing script before using run().
: "${DRY_RUN:=0}"

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

# run <description> -- <command...>
# Prints the description (and the exact command) under --dry-run instead of
# executing it. Every mutating action in these scripts goes through this so
# --dry-run has one enforcement point instead of an if/else at every call site.
run() {
  local desc="$1"
  shift
  if [[ "${1:-}" != "--" ]]; then
    die "run(): expected '--' before the command, got '${1:-}'"
  fi
  shift
  if [[ "$DRY_RUN" == "1" ]]; then
    print_dry_run_command "$desc" "$@"
    return 0
  fi
  log "$desc"
  "$@"
}

# quote_for_display <arg>
# Ordinary shell quoting for one argument, for printing a copy-pasteable
# command in --dry-run output. Plain-looking args are left bare; anything
# else is wrapped in single quotes with embedded single quotes escaped as
# '\''. This reads as a normal shell command; printf '%q' instead escapes
# every special character individually (backslash-per-char), which is
# correct but unreadable once an arg has spaces or quotes in it, e.g. a
# --dry-run disk placeholder like "<dev matching model='Foo Bar'>".
quote_for_display() {
  local arg="$1"
  if [[ "$arg" =~ ^[A-Za-z0-9_./:=@%+-]+$ ]]; then
    printf '%s' "$arg"
  else
    printf "'%s'" "${arg//\'/\'\\\'\'}"
  fi
}

# print_dry_run_command <description> <command...>
# Shared by run() and with_retry() so --dry-run output stays readable and
# consistent between them.
print_dry_run_command() {
  local desc="$1"
  shift
  printf '[dry-run] %s\n' "$desc"
  local quoted=() a
  for a in "$@"; do
    quoted+=("$(quote_for_display "$a")")
  done
  printf '[dry-run]   $ %s\n' "${quoted[*]}"
}

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    die "This script must run as root (it partitions disks / writes system files)."
  fi
}

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "Required command not found on PATH: $cmd"
  done
}

# resolve_disk_by_model_serial <model-substring> <serial-substring>
# Finds exactly one whole-disk block device by matching lsblk MODEL/SERIAL
# fields, never by kernel name (sdX/nvmeX names are not stable once a second
# drive is added). Prints the resolved /dev path, or dies.
resolve_disk_by_model_serial() {
  local model="$1" serial="$2" lsblk_json
  lsblk_json="$(lsblk -J -o NAME,TYPE,MODEL,SERIAL,PATH)"
  python3 -I - "$model" "$serial" "$lsblk_json" <<'PY'
import json, sys
model, serial, lsblk_json = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.loads(lsblk_json)
matches = []
def walk(devices):
    for d in devices:
        if d.get("type") == "disk":
            m = (d.get("model") or "").strip()
            s = (d.get("serial") or "").strip()
            if (not model or model in m) and (not serial or serial in s):
                matches.append(d.get("path") or f"/dev/{d.get('name')}")
walk(data.get("blockdevices", []))
if len(matches) != 1:
    sys.stderr.write(f"Expected exactly one disk matching model~={model!r} serial~={serial!r}, found {matches}\n")
    sys.exit(1)
print(matches[0])
PY
}

# disk_has_partitions <dev>
# True (exit 0) if the whole-disk device already has one or more partitions.
disk_has_partitions() {
  local dev="$1" lsblk_json count
  lsblk_json="$(lsblk -J -o NAME,TYPE "$dev")"
  count="$(python3 -I - "$lsblk_json" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
devs = data.get("blockdevices", [])
n = sum(1 for d in devs for c in d.get("children", []) if c.get("type") == "part")
print(n)
PY
)"
  [[ "${count:-0}" -gt 0 ]]
}

# with_retry <description> <max-attempts> <base-delay-seconds> -- <command...>
# Retries a flaky command (rclone against a flaky Drive API, say) with
# exponential backoff: base, base*2, base*4, ... Honors DRY_RUN via run().
with_retry() {
  local desc="$1" max_attempts="$2" base_delay="$3"
  shift 3
  if [[ "${1:-}" != "--" ]]; then
    die "with_retry(): expected '--' before the command, got '${1:-}'"
  fi
  shift
  local attempt=1 delay="$base_delay"
  while true; do
    if [[ "$DRY_RUN" == "1" ]]; then
      print_dry_run_command "$desc (attempt $attempt/$max_attempts, retrying with backoff on failure)" "$@"
      return 0
    fi
    log "$desc (attempt $attempt/$max_attempts)"
    if "$@"; then
      return 0
    fi
    if [[ "$attempt" -ge "$max_attempts" ]]; then
      die "$desc failed after $max_attempts attempts"
    fi
    log "Attempt $attempt failed, retrying in ${delay}s..."
    sleep "$delay"
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done
}

# make_exec_capable_tempdir <prefix> [fallback-parent-dir]
# Creates a temp directory under $TMPDIR (or /tmp) and verifies it actually
# allows executing files there -- some hosts mount /tmp noexec, which would
# silently break any check that stages stub/test executables into a plain
# mktemp -d. Falls back to a dot-directory under [fallback-parent-dir]
# (default: this file's own directory) if the first location can't execute
# anything. Prints the directory path; the caller owns cleanup.
make_exec_capable_tempdir() {
  local prefix="$1" fallback_parent="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}" dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/${prefix}.XXXXXX")"
  printf '#!/bin/sh\n' > "$dir/.exectest"
  chmod +x "$dir/.exectest"
  if "$dir/.exectest" 2>/dev/null; then
    rm -f "$dir/.exectest"
    printf '%s\n' "$dir"
    return 0
  fi
  rm -rf "$dir"
  dir="$(mktemp -d "$fallback_parent/.${prefix}.XXXXXX")"
  printf '%s\n' "$dir"
}

# meminfo_kb <field>
# One /proc/meminfo field in kB (MemAvailable, SwapTotal, SwapFree, ...).
# PAPERCLIP_MEMINFO_PATH lets the offline tests point this at a fake file;
# nothing on a real host sets it.
meminfo_kb() {
  local field="$1" kb
  kb="$(awk -v f="${field}:" '$1 == f {print $2}' "${PAPERCLIP_MEMINFO_PATH:-/proc/meminfo}")"
  [[ -n "$kb" ]] || die "Could not read $field from ${PAPERCLIP_MEMINFO_PATH:-/proc/meminfo}."
  printf '%s\n' "$kb"
}

# mem_available_mb
# Reads /proc/meminfo's MemAvailable directly (kB -> MB), never `free`'s
# output: MemAvailable already excludes reclaimable-but-unusable memory, and
# avoids depending on `free` being installed. Swap is never counted -- a
# build that only "fits" in swap thrashes instead of finishing.
mem_available_mb() {
  local kb
  kb="$(meminfo_kb MemAvailable)"
  echo $((kb / 1024))
}

# require_memory_available_mb <min-mb> <what>
# Pre-flight gate: dies before starting <what> if MemAvailable is already
# below <min-mb>. Lesson paid for on the ZimaBoard host build (BUILD_EXIT=90):
# catching this before any build work starts is cheaper than discovering it
# an hour in.
require_memory_available_mb() {
  local min_mb="$1" what="$2" avail
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] would require at least ${min_mb}MB MemAvailable before starting: $what"
    return 0
  fi
  avail="$(mem_available_mb)"
  if [[ "$avail" -lt "$min_mb" ]]; then
    die "Only ${avail}MB available (need >= ${min_mb}MB) before starting: $what. Free memory first; do not retry blindly (BUILD_EXIT=90-class failure)."
  fi
  log "Memory pre-flight OK: ${avail}MB available (need >= ${min_mb}MB) before: $what"
}

# --- Build containment (TOM-686) --------------------------------------------
# On 21 Oct a release build took the ZimaBoard down: swap was already 99%
# full, `pnpm -r build` ran unbounded, the host live-locked before the old
# 1200MB guard fired, and the guard's `kill` reached only a bash subshell, so
# tsc kept running for 41 more minutes. The settings below are the fix. Every
# one is a default the calling script may override (paperclip-update.sh maps
# its flags onto them); see deploy/native/zimaos/README.md for why each
# value is what it is.
#
# BUILD_SCOPE_MODE: auto | systemd | setsid. auto picks systemd when this
# runs as root on a systemd host with systemd-run, else setsid.
: "${BUILD_SCOPE_MODE:=auto}"
# Transient unit name (without .scope); callers set paperclip-build-<sha>.
: "${BUILD_SCOPE_UNIT:=paperclip-build-$$}"
# Hard ceiling (MemoryMax) and swap allowance (MemorySwapMax) of the scope.
: "${BUILD_MEMORY_MAX_MB:=8192}"
: "${BUILD_SWAP_MAX_MB:=256}"
# Low CPU and IO priority, so the live server and agent runs win contention.
: "${BUILD_CPU_WEIGHT:=20}"
: "${BUILD_IO_WEIGHT:=20}"
: "${BUILD_NICE:=10}"
# SIGTERM-to-SIGKILL grace when the guard trips or the update aborts.
: "${BUILD_KILL_GRACE_SECONDS:=10}"

# Runtime state of the one build run_memory_guarded() is supervising, read
# by build_guard_stop() (also called from paperclip-update.sh's exit trap).
BUILD_GUARD_MODE=""
BUILD_GUARD_LEADER=""
BUILD_GUARD_CGROUP=""
BUILD_GUARD_PEAK_BYTES=0

# require_build_preflight <what> <reserve-mb> <min-ceiling-mb> <max-swap-used-pct>
# Refuses to start <what> on a host that is already under memory pressure,
# then clamps BUILD_MEMORY_MAX_MB so the build can never take MemAvailable
# below <reserve-mb>:
#   - swap use above <max-swap-used-pct>% of SwapTotal: refuse. The 21 Oct
#     host had 5209MB of 5248MB swap in use two hours before the build; with
#     swap that full the kernel thrashes instead of OOM-killing anything.
#   - MemAvailable below <reserve-mb> + <min-ceiling-mb>: refuse. Clamping
#     the ceiling under <min-ceiling-mb> would only make the build die of
#     its own OOM a few minutes in.
#   - otherwise BUILD_MEMORY_MAX_MB = min(BUILD_MEMORY_MAX_MB,
#     MemAvailable - <reserve-mb>).
# Dies with a BUILD_EXIT=90-class message on refusal.
require_build_preflight() {
  local what="$1" reserve_mb="$2" min_ceiling_mb="$3" max_swap_pct="$4"
  local avail swap_total_kb swap_free_kb swap_used_mb swap_total_mb swap_pct=0 headroom
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] pre-flight: would refuse to start ($what) if swap use is above ${max_swap_pct}% of SwapTotal (the 21 Oct host had 5209MB of 5248MB in use)"
    log "[dry-run] pre-flight: would refuse if MemAvailable < ${reserve_mb}MB reserve + ${min_ceiling_mb}MB minimum build ceiling = $((reserve_mb + min_ceiling_mb))MB"
    log "[dry-run] pre-flight: would clamp the build's MemoryMax to min(${BUILD_MEMORY_MAX_MB}MB, MemAvailable - ${reserve_mb}MB) so the host keeps >= ${reserve_mb}MB available"
    return 0
  fi
  swap_total_kb="$(meminfo_kb SwapTotal)"
  swap_free_kb="$(meminfo_kb SwapFree)"
  swap_total_mb=$((swap_total_kb / 1024))
  swap_used_mb=$(((swap_total_kb - swap_free_kb) / 1024))
  if [[ "$swap_total_kb" -gt 0 ]]; then
    swap_pct=$(((swap_total_kb - swap_free_kb) * 100 / swap_total_kb))
  fi
  if [[ "$swap_pct" -gt "$max_swap_pct" ]]; then
    die "Refusing to start ($what): swap is already ${swap_used_mb}MB of ${swap_total_mb}MB used (${swap_pct}%, limit ${max_swap_pct}%). The host is under memory pressure and a build now can freeze it, as on 21 Oct. Find what holds the swap (often a long-running paperclip-native.service; restart it in a quiet window) and retry (BUILD_EXIT=90-class failure)."
  fi
  avail="$(mem_available_mb)"
  if [[ "$avail" -lt $((reserve_mb + min_ceiling_mb)) ]]; then
    die "Refusing to start ($what): only ${avail}MB available, need >= $((reserve_mb + min_ceiling_mb))MB (${reserve_mb}MB kept for the host + ${min_ceiling_mb}MB minimum for the build). Free memory first (for example stop the hermes-browser container for the build), then retry (BUILD_EXIT=90-class failure)."
  fi
  headroom=$((avail - reserve_mb))
  if [[ "$headroom" -lt "$BUILD_MEMORY_MAX_MB" ]]; then
    log "Clamping the build ceiling from ${BUILD_MEMORY_MAX_MB}MB to ${headroom}MB so MemAvailable stays >= ${reserve_mb}MB"
    BUILD_MEMORY_MAX_MB="$headroom"
  fi
  log "Memory pre-flight OK: ${avail}MB available, swap ${swap_used_mb}/${swap_total_mb}MB (${swap_pct}%), build ceiling ${BUILD_MEMORY_MAX_MB}MB, host reserve ${reserve_mb}MB: $what"
}

# build_scope_probe
# Starts and collects a throwaway scope with the same properties the build
# scope uses, so a systemd that rejects one of them (or a host where
# transient scopes are not allowed) is caught before the build, not as an
# unexplained instant build failure.
build_scope_probe() {
  systemd-run --scope --quiet --collect --unit="paperclip-build-probe-$$" \
    -p "MemoryMax=${BUILD_MEMORY_MAX_MB}M" -p "MemorySwapMax=${BUILD_SWAP_MAX_MB}M" \
    -p "CPUWeight=$BUILD_CPU_WEIGHT" -p "IOWeight=$BUILD_IO_WEIGHT" --nice="$BUILD_NICE" \
    -- true >/dev/null 2>&1
}

# build_scope_mode
# Resolves BUILD_SCOPE_MODE=auto to systemd or setsid (run_memory_guarded
# caches the answer in BUILD_GUARD_MODE).
build_scope_mode() {
  if [[ -n "$BUILD_GUARD_MODE" ]]; then
    printf '%s\n' "$BUILD_GUARD_MODE"
    return 0
  fi
  case "$BUILD_SCOPE_MODE" in
    systemd|setsid) printf '%s\n' "$BUILD_SCOPE_MODE" ;;
    auto)
      # A --dry-run plans the real run, which is root; so it ignores EUID.
      if [[ ("${EUID:-$(id -u)}" -eq 0 || "$DRY_RUN" == "1") && -d /run/systemd/system ]] && command -v systemd-run >/dev/null 2>&1; then
        if [[ "$DRY_RUN" == "1" ]] || build_scope_probe; then
          echo systemd
        else
          log "WARNING: systemd-run cannot create a transient scope with the build's limits on this host; falling back to a setsid process group (no MemoryMax ceiling)."
          echo setsid
        fi
      else
        echo setsid
      fi
      ;;
    *) die "BUILD_SCOPE_MODE must be auto, systemd or setsid (got: $BUILD_SCOPE_MODE)" ;;
  esac
}

# process_group_members <pgid>
# Prints the PID of every live (non-zombie) process whose process group is
# <pgid>. Reads /proc directly so it needs no pgrep.
process_group_members() {
  local pgid="$1" f stat rest state pgrp
  for f in /proc/[0-9]*/stat; do
    { stat="$(<"$f")"; } 2>/dev/null || continue
    rest="${stat##*) }"
    read -r state _ pgrp _ <<<"$rest"
    [[ "$pgrp" == "$pgid" && "$state" != "Z" ]] && printf '%s\n' "$(basename "$(dirname "$f")")"
  done
  return 0
}

# build_guard_cgroup_procs
# Prints the PIDs still in the build scope's cgroup (nothing once the scope
# is gone -- systemd removes the cgroup when its last process exits).
build_guard_cgroup_procs() {
  [[ -n "$BUILD_GUARD_CGROUP" && -r "/sys/fs/cgroup$BUILD_GUARD_CGROUP/cgroup.procs" ]] || return 0
  cat "/sys/fs/cgroup$BUILD_GUARD_CGROUP/cgroup.procs" 2>/dev/null || true
}

# build_guard_survivors
# Every process the supervised build still has: its process group, plus
# (systemd mode) its cgroup, which also catches a process that left the
# group with its own setsid.
build_guard_survivors() {
  [[ -n "$BUILD_GUARD_LEADER" ]] || return 0
  { process_group_members "$BUILD_GUARD_LEADER"; build_guard_cgroup_procs; } | sort -u
}

# build_guard_signal <signal>
# Sends <signal> to the whole build: the process group, every PID in the
# scope's cgroup, and (systemd mode) the scope itself via systemctl kill.
build_guard_signal() {
  local sig="$1" pid
  kill "-$sig" -- "-$BUILD_GUARD_LEADER" 2>/dev/null || true
  kill "-$sig" "$BUILD_GUARD_LEADER" 2>/dev/null || true
  for pid in $(build_guard_cgroup_procs); do
    kill "-$sig" "$pid" 2>/dev/null || true
  done
  if [[ "$BUILD_GUARD_MODE" == "systemd" ]]; then
    systemctl kill --signal="SIG$sig" "$BUILD_SCOPE_UNIT.scope" >/dev/null 2>&1 || true
  fi
}

# build_guard_stop
# Stops every process of the supervised build: SIGTERM, up to
# BUILD_KILL_GRACE_SECONDS for it to exit, SIGKILL, then confirms that no
# process is left in its process group or cgroup. Returns 0 when the build
# is fully gone (or there was none), 1 if anything survived SIGKILL.
# Idempotent; safe to call from an exit trap.
build_guard_stop() {
  local i survivors
  [[ -n "$BUILD_GUARD_LEADER" ]] || return 0
  survivors="$(build_guard_survivors)"
  if [[ -n "$survivors" ]]; then
    log "Stopping the build ($BUILD_GUARD_MODE mode, process group $BUILD_GUARD_LEADER${BUILD_GUARD_CGROUP:+, cgroup $BUILD_GUARD_CGROUP}): SIGTERM, then SIGKILL after ${BUILD_KILL_GRACE_SECONDS}s"
    build_guard_signal TERM
    for ((i = 0; i < BUILD_KILL_GRACE_SECONDS * 4; i++)); do
      [[ -z "$(build_guard_survivors)" ]] && break
      sleep 0.25
    done
    if [[ -n "$(build_guard_survivors)" ]]; then
      build_guard_signal KILL
      for ((i = 0; i < 40; i++)); do
        [[ -z "$(build_guard_survivors)" ]] && break
        sleep 0.25
      done
    fi
  fi
  if [[ "$BUILD_GUARD_MODE" == "systemd" ]]; then
    systemctl stop "$BUILD_SCOPE_UNIT.scope" >/dev/null 2>&1 || true
  fi
  wait "$BUILD_GUARD_LEADER" 2>/dev/null || true
  survivors="$(build_guard_survivors)"
  if [[ -n "$survivors" ]]; then
    log "ERROR: build processes survived SIGKILL: ${survivors//$'\n'/ }"
    return 1
  fi
  log "Confirmed: no build process left (process group $BUILD_GUARD_LEADER is empty${BUILD_GUARD_CGROUP:+, cgroup.procs is empty})"
  BUILD_GUARD_LEADER=""
  return 0
}

# build_guard_sample_cgroup
# systemd mode only: records the scope's cgroup path and its memory.peak.
build_guard_sample_cgroup() {
  local line peak
  [[ "$BUILD_GUARD_MODE" == "systemd" ]] || return 0
  if [[ -z "$BUILD_GUARD_CGROUP" && -r "/proc/$BUILD_GUARD_LEADER/cgroup" ]]; then
    line="$(grep -m1 '^0::' "/proc/$BUILD_GUARD_LEADER/cgroup" 2>/dev/null || true)"
    [[ "${line#0::}" == *"/$BUILD_SCOPE_UNIT.scope" ]] && BUILD_GUARD_CGROUP="${line#0::}"
  fi
  if [[ -n "$BUILD_GUARD_CGROUP" && -r "/sys/fs/cgroup$BUILD_GUARD_CGROUP/memory.peak" ]]; then
    peak="$(cat "/sys/fs/cgroup$BUILD_GUARD_CGROUP/memory.peak" 2>/dev/null || echo 0)"
    [[ "$peak" =~ ^[0-9]+$ && "$peak" -gt "$BUILD_GUARD_PEAK_BYTES" ]] && BUILD_GUARD_PEAK_BYTES="$peak"
  fi
  return 0
}

# The first process inside the scope. It raises its own oom_score_adj to
# 1000 (allowed unprivileged), so if the kernel ever has to OOM-kill
# anything host-wide the build goes first; runs the build; then, still
# inside the scope, prints the scope's exact memory.peak before it exits
# (systemd removes the cgroup, and memory.peak with it, once it is empty).
# shellcheck disable=SC2016 # expanded by the inner bash, not here
BUILD_SCOPE_WRAPPER='echo 1000 > /proc/self/oom_score_adj 2>/dev/null; "$@"; rc=$?; cg="$(sed -n "s/^0:://p" /proc/self/cgroup 2>/dev/null)"; if [[ "$cg" == *.scope && -r "/sys/fs/cgroup$cg/memory.peak" ]]; then echo "[build-scope] ${cg##*/} memory.peak=$(( $(cat "/sys/fs/cgroup$cg/memory.peak") / 1048576 ))MB" >&2; fi; exit "$rc"'

# build_guard_launch_argv <mode> <command...>
# Sets BUILD_GUARD_ARGV to the full argv that runs <command...> contained:
# systemd mode: systemd-run --scope with MemoryMax/MemorySwapMax/CPUWeight/
# IOWeight/--nice, then setsid; setsid mode: nice + setsid only.
build_guard_launch_argv() {
  local mode="$1"
  shift
  if [[ "$mode" == "systemd" ]]; then
    BUILD_GUARD_ARGV=(systemd-run --scope --quiet --collect --unit="$BUILD_SCOPE_UNIT"
      -p "MemoryMax=${BUILD_MEMORY_MAX_MB}M" -p "MemorySwapMax=${BUILD_SWAP_MAX_MB}M"
      -p "CPUWeight=$BUILD_CPU_WEIGHT" -p "IOWeight=$BUILD_IO_WEIGHT" --nice="$BUILD_NICE"
      -- setsid bash -c "$BUILD_SCOPE_WRAPPER" paperclip-build "$@")
  else
    BUILD_GUARD_ARGV=(nice -n "$BUILD_NICE" setsid bash -c "$BUILD_SCOPE_WRAPPER" paperclip-build "$@")
  fi
}

# run_memory_guarded <description> <min-mb> <poll-seconds> -- <command...>
# Runs <command...> contained, and polls host MemAvailable every
# <poll-seconds>; if it drops below <min-mb> while the command is still
# running, stops the whole build and dies (BUILD_EXIT=91-class failure: the
# build started fine but the host ran low partway through, e.g. another
# process competing for RAM). Honors DRY_RUN.
#
# Containment (see build_guard_launch_argv): as root on systemd, the build
# runs in its own transient scope $BUILD_SCOPE_UNIT.scope with a hard
# MemoryMax, so its own OOM happens inside the scope instead of across the
# host; everywhere it also runs in its own process group (setsid). On a trip
# or an abort the whole group and cgroup get SIGTERM, then SIGKILL, and the
# guard confirms nothing is left before it dies. <command...> must be an
# external command: a shell function would run in a subshell outside any of
# that (the 21 Oct bug), so it is refused.
run_memory_guarded() {
  local desc="$1" min_mb="$2" poll_seconds="$3"
  shift 3
  if [[ "${1:-}" != "--" ]]; then
    die "run_memory_guarded(): expected '--' before the command, got '${1:-}'"
  fi
  shift
  if [[ "$DRY_RUN" == "1" ]]; then
    local planned_mode
    planned_mode="$(build_scope_mode)"
    build_guard_launch_argv "$planned_mode" "$@"
    print_dry_run_command "$desc (contained: $planned_mode mode, scope $BUILD_SCOPE_UNIT.scope MemoryMax=${BUILD_MEMORY_MAX_MB}M MemorySwapMax=${BUILD_SWAP_MAX_MB}M; abort if host MemAvailable < ${min_mb}MB, checked every ${poll_seconds}s; on abort SIGTERM then SIGKILL the whole scope/process group and confirm it is empty)" "${BUILD_GUARD_ARGV[@]}"
    return 0
  fi
  if declare -F "$1" >/dev/null 2>&1; then
    die "run_memory_guarded(): '$1' is a shell function; pass an external command (see drop_priv_argv) so the build runs in its own scope and process group."
  fi
  BUILD_GUARD_MODE="$(build_scope_mode)"
  build_guard_launch_argv "$BUILD_GUARD_MODE" "$@"
  BUILD_GUARD_CGROUP=""
  BUILD_GUARD_PEAK_BYTES=0
  if [[ "$BUILD_GUARD_MODE" == "systemd" ]]; then
    # A scope left over from an earlier aborted attempt still holds its
    # processes (and its unit name); stop it before reusing the name.
    systemctl stop "$BUILD_SCOPE_UNIT.scope" >/dev/null 2>&1 || true
  fi
  if [[ "$BUILD_GUARD_MODE" == "systemd" ]]; then
    log "$desc (contained: scope $BUILD_SCOPE_UNIT.scope, MemoryMax=${BUILD_MEMORY_MAX_MB}M, MemorySwapMax=${BUILD_SWAP_MAX_MB}M, CPUWeight=$BUILD_CPU_WEIGHT, IOWeight=$BUILD_IO_WEIGHT, nice $BUILD_NICE, own process group; abort if MemAvailable < ${min_mb}MB)"
  else
    log "$desc (contained: own process group only, nice $BUILD_NICE, no MemoryMax ceiling; abort if MemAvailable < ${min_mb}MB)"
  fi
  # 9>&-: never hand paperclip-update.sh's lock descriptor to the build.
  "${BUILD_GUARD_ARGV[@]}" 9>&- &
  BUILD_GUARD_LEADER=$!
  local watchdog_tripped=0 avail rc=0
  while kill -0 "$BUILD_GUARD_LEADER" 2>/dev/null; do
    build_guard_sample_cgroup
    avail="$(mem_available_mb)"
    if [[ "$avail" -lt "$min_mb" ]]; then
      log "WATCHDOG: avail=${avail}MB < ${min_mb}MB, cancelling: $desc"
      watchdog_tripped=1
      break
    fi
    sleep "$poll_seconds"
  done
  if [[ "$watchdog_tripped" == "1" ]]; then
    build_guard_stop || die "$desc aborted: memory dropped below ${min_mb}MB mid-run, and some build processes survived SIGKILL (see above). Investigate before retrying (BUILD_EXIT=91-class failure)."
    die "$desc aborted: memory dropped below ${min_mb}MB mid-run (BUILD_EXIT=91-class failure). Every build process is confirmed stopped. Free memory and retry."
  fi
  wait "$BUILD_GUARD_LEADER" || rc=$?
  if [[ -n "$(build_guard_survivors)" ]]; then
    log "The build's main process exited but left processes behind; stopping them."
  fi
  build_guard_stop || true
  if [[ "$BUILD_GUARD_MODE" == "systemd" && "$BUILD_GUARD_PEAK_BYTES" -gt 0 ]]; then
    log "Build scope $BUILD_SCOPE_UNIT.scope memory.peak (sampled every ${poll_seconds}s; the exact value is the [build-scope] line above): $((BUILD_GUARD_PEAK_BYTES / 1048576))MB of ${BUILD_MEMORY_MAX_MB}MB MemoryMax"
  fi
  if [[ "$rc" -ne 0 ]]; then
    if [[ "$BUILD_GUARD_MODE" == "systemd" && $((BUILD_GUARD_PEAK_BYTES / 1048576)) -ge $((BUILD_MEMORY_MAX_MB * 95 / 100)) ]]; then
      log "The build reached its ${BUILD_MEMORY_MAX_MB}MB MemoryMax ceiling, so the kernel most likely OOM-killed a build process inside the scope (the host was not affected)."
    fi
    return "$rc"
  fi
  return 0
}

# health_ok <url>
# One /api/health probe: exit 0 if it answers 2xx within 5 seconds.
health_ok() {
  curl -fsS --max-time 5 "$1" >/dev/null 2>&1
}

# wait_for_health_url <url> <attempts> <delay-seconds>
wait_for_health_url() {
  local url="$1" attempts="$2" delay="$3" i
  for ((i = 1; i <= attempts; i++)); do
    if health_ok "$url"; then
      log "Health check OK (attempt $i/$attempts)"
      return 0
    fi
    log "Health check not ready yet (attempt $i/$attempts)"
    sleep "$delay"
  done
  return 1
}

# --- paperclip-update.sh exit safety net (TOM-686) ---------------------------
# State the update script keeps current as it goes, read by the trap below.
# UPDATE_PHASE: init -> snapshot -> build -> switched (current points at the
# new release, no restart yet) -> restarted -> rollback -> done (verified).
UPDATE_PHASE="init"
UPDATE_SERVICE="paperclip-native.service"
UPDATE_HEALTH_URL=""
UPDATE_CURRENT_LINK=""
UPDATE_PREV_RELEASE=""
UPDATE_MIGRATION_RAN=0
: "${UPDATE_HEALTH_ATTEMPTS:=12}"
: "${UPDATE_HEALTH_DELAY:=5}"

# update_exit_safety_net <exit-code>
# The EXIT trap of paperclip-update.sh. After a successful update
# (UPDATE_PHASE=done) it only makes sure no build process is left. After any
# failure, abort or signal, at any stage, it:
#   1. stops the build scope / process group (build_guard_stop);
#   2. points `current` back at the previous release if the update had
#      already switched it (the server may run that release next restart);
#   3. probes /api/health and restarts the service, then waits for health,
#      ONLY if the server is down. A healthy server is never restarted.
# Then exits with the original exit code.
update_exit_safety_net() {
  local rc="$1"
  trap - EXIT INT TERM HUP
  set +e
  if [[ "$DRY_RUN" == "1" ]]; then
    if [[ "$rc" -ne 0 ]]; then
      log "[dry-run] exit trap: the update stopped with exit code $rc during '$UPDATE_PHASE'; a real run would now stop $BUILD_SCOPE_UNIT.scope, check $UPDATE_HEALTH_URL and restart $UPDATE_SERVICE only if it is down"
    fi
    exit "$rc"
  fi
  if [[ "$UPDATE_PHASE" == "done" ]]; then
    build_guard_stop >/dev/null 2>&1
    exit "$rc"
  fi
  log "== Exit safety net: the update stopped with exit code $rc during '$UPDATE_PHASE' =="
  build_guard_stop || log "WARNING: some build processes could not be stopped (see above)."
  local revert=0
  case "$UPDATE_PHASE" in
    switched|restarted) [[ -n "$UPDATE_PREV_RELEASE" && -n "$UPDATE_CURRENT_LINK" ]] && revert=1 ;;
  esac
  if [[ "$revert" == "1" && "$UPDATE_PHASE" == "switched" ]]; then
    # Nothing was restarted yet, so the running server is still the previous
    # release; only the symlink has to go back.
    ln -sfn "$UPDATE_PREV_RELEASE" "$UPDATE_CURRENT_LINK" && log "Pointed $UPDATE_CURRENT_LINK back at $UPDATE_PREV_RELEASE (it had not been restarted onto the new release yet)."
  fi
  if health_ok "$UPDATE_HEALTH_URL"; then
    log "Server is healthy at $UPDATE_HEALTH_URL; not restarting it."
  else
    log "Server is DOWN at $UPDATE_HEALTH_URL; restarting $UPDATE_SERVICE."
    if [[ "$revert" == "1" ]]; then
      ln -sfn "$UPDATE_PREV_RELEASE" "$UPDATE_CURRENT_LINK" && log "Pointed $UPDATE_CURRENT_LINK back at $UPDATE_PREV_RELEASE before the restart."
      [[ "$UPDATE_MIGRATION_RAN" == "1" ]] && log "WARNING: migrations differ for this update and the exit trap does not restore the DB snapshot; check the database once the server is up."
    fi
    systemctl restart "$UPDATE_SERVICE" || log "ERROR: systemctl restart $UPDATE_SERVICE failed."
    if wait_for_health_url "$UPDATE_HEALTH_URL" "$UPDATE_HEALTH_ATTEMPTS" "$UPDATE_HEALTH_DELAY"; then
      log "Server is healthy again after the safety-net restart."
    else
      log "ERROR: server still unhealthy after the safety-net restart. Manual intervention required."
    fi
  fi
  exit "$rc"
}

# arm_update_exit_trap
# Installs update_exit_safety_net on EXIT, and turns SIGINT/SIGTERM/SIGHUP
# into an exit (128+signal) so the same trap runs for them too.
arm_update_exit_trap() {
  trap 'update_exit_safety_net "$?"' EXIT
  trap 'log "Received SIGINT"; exit 130' INT
  trap 'log "Received SIGTERM"; exit 143' TERM
  trap 'log "Received SIGHUP"; exit 129' HUP
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] exit trap armed (EXIT, INT, TERM, HUP): after any failure or signal it stops $BUILD_SCOPE_UNIT.scope, points current back if the update had switched it, checks $UPDATE_HEALTH_URL and restarts $UPDATE_SERVICE only if the server is down -- never a healthy server"
  fi
}

# --- Host safety net units (TOM-686) -----------------------------------------
# Recovery-path scripts, units and drop-ins that paperclip-update.sh installs
# on every update (and install-native-zimaos.sh on a first install). All of
# them point only at the recovery path and systemctl, never into a release,
# so they keep working after a rollback to a release that predates them.
SAFETY_NET_SCRIPTS=(paperclip-recover.sh paperclip-oom-guard.sh)
SAFETY_NET_UNITS=(
  paperclip-native-recover.service
  paperclip-native-oom-guard.service
  paperclip-native.service.d/50-oom-guard.conf
  paperclip-native-watchdog.service.d/50-recover.conf
)
# The checked-in units use these documented defaults as literal paths (so
# systemd-analyze can verify them as-is); install renders them per host.
UNIT_DEFAULT_ROOT="/DATA/.media/External SSD/paperclip-native"
UNIT_DEFAULT_MOUNT_PATH="/DATA/.media/External SSD"
UNIT_DEFAULT_RECOVERY_BASE="/usr/local/lib/paperclip"

# render_unit_file <src> <dst> <root> <mount-path> <recovery-base>
render_unit_file() {
  local src="$1" dst="$2" root="$3" mount="$4" recovery="$5"
  sed -e "s#${UNIT_DEFAULT_ROOT}#${root}#g" \
      -e "s#${UNIT_DEFAULT_MOUNT_PATH}#${mount}#g" \
      -e "s#${UNIT_DEFAULT_RECOVERY_BASE}#${recovery}#g" \
      "$src" >"$dst"
}

# install_if_changed <mode> <src> <dst>
# Copies <src> to <dst> only when the content differs; returns 0 if it
# wrote, 1 if <dst> was already identical.
install_if_changed() {
  local mode="$1" src="$2" dst="$3"
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
    return 1
  fi
  mkdir -p "$(dirname "$dst")"
  install -m "$mode" "$src" "$dst"
  return 0
}

# install_safety_net <zimaos-dir> <root> <mount-path> <recovery-base>
# Idempotent: copies each recovery script and rendered unit/drop-in only if
# it changed, runs `systemctl daemon-reload` only if a unit changed, then
# starts the OOM guard (a no-op if it already runs). Never restarts
# paperclip-native.service. PAPERCLIP_SYSTEMD_DIR overrides
# /etc/systemd/system for the offline tests.
install_safety_net() {
  local zimaos_dir="$1" root="$2" mount="$3" recovery="$4"
  local systemd_dir="${PAPERCLIP_SYSTEMD_DIR:-/etc/systemd/system}" f staged changed_units=0 changed=()
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] would install (only if changed) into $recovery/scripts: ${SAFETY_NET_SCRIPTS[*]}"
    log "[dry-run] would install (only if changed) into $systemd_dir, rendered for root=$root mount=$mount recovery=$recovery: ${SAFETY_NET_UNITS[*]}"
    log "[dry-run] would run systemctl daemon-reload only if a unit changed, then: systemctl start paperclip-native-oom-guard.service (never restarts paperclip-native.service)"
    return 0
  fi
  staged="$(mktemp -d "$root/logs/.safety-net.XXXXXX")"
  for f in "${SAFETY_NET_SCRIPTS[@]}"; do
    if install_if_changed 755 "$zimaos_dir/scripts/$f" "$recovery/scripts/$f"; then
      changed+=("$recovery/scripts/$f")
    fi
  done
  for f in "${SAFETY_NET_UNITS[@]}"; do
    mkdir -p "$staged/$(dirname "$f")"
    render_unit_file "$zimaos_dir/systemd/$f" "$staged/$f" "$root" "$mount" "$recovery"
    if install_if_changed 644 "$staged/$f" "$systemd_dir/$f"; then
      changed+=("$systemd_dir/$f")
      changed_units=1
    fi
  done
  rm -rf "$staged"
  if [[ ${#changed[@]} -eq 0 ]]; then
    log "Safety-net scripts and units already up to date; nothing to install."
  else
    log "Installed or updated: ${changed[*]}"
  fi
  if [[ "$changed_units" == "1" ]]; then
    systemctl daemon-reload
  fi
  systemctl start paperclip-native-oom-guard.service || log "WARNING: could not start paperclip-native-oom-guard.service; the server is unprotected from the OOM killer until it starts."
}

# mount_source_uuid <path>
# Resolves the filesystem UUID backing the mount that <path> lives on, via
# findmnt + blkid -- never by assuming a /dev/sdX name, which has already
# shifted once on the ZimaBoard host when a second drive was fitted.
mount_source_uuid() {
  local path="$1" dev uuid
  dev="$(findmnt -no SOURCE --target "$path")" || die "Could not resolve the mount backing '$path' via findmnt."
  uuid="$(blkid -s UUID -o value "$dev")" || die "Could not read a filesystem UUID for '$dev' (mount of '$path')."
  [[ -n "$uuid" ]] || die "blkid returned an empty UUID for '$dev' (mount of '$path')."
  printf '%s\n' "$uuid"
}

# require_mount_uuid <path> <expected-uuid>
# Dies if <path>'s backing filesystem UUID does not match <expected-uuid>.
# Skipped under --dry-run (the placeholder root may not exist yet). Pass an
# empty <expected-uuid> to skip the check (no UUID pinned yet).
require_mount_uuid() {
  local path="$1" expected="$2" actual
  [[ -n "$expected" ]] || { log "No expected UUID pinned for '$path'; skipping the UUID check."; return 0; }
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] would require '$path' to be backed by filesystem UUID=$expected"
    return 0
  fi
  actual="$(mount_source_uuid "$path")"
  [[ "$actual" == "$expected" ]] || die "'$path' is backed by filesystem UUID=$actual, expected UUID=$expected. Refusing to proceed: device enumeration may have shifted (see the 8 Oct outage)."
  log "UUID check OK: '$path' is backed by filesystem UUID=$actual"
}

# copy_tree <src> <dst>
# Copies the contents of <src> into <dst> (creating <dst> if needed),
# preserving ownership, permissions and timestamps, without removing
# anything already present in <dst>. Uses `rsync -a` when it is on PATH;
# otherwise falls back to a `tar | tar` pipe, since ZimaOS is a Buildroot
# appliance with no package manager and may have no rsync installed at
# all. Never add rsync to a hard require_cmd check in a script that calls
# this -- that would defeat the whole point of the fallback.
copy_tree() {
  local src="$1" dst="$2"
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "$src"/ "$dst"/
  else
    tar -C "$src" -cf - . | tar -C "$dst" -xf -
  fi
}

# copy_tree_mirror <src> <dst>
# Like copy_tree, but mirrors <src> onto <dst> exactly: anything in <dst>
# that is not in <src> is removed first. Uses `rsync -a --delete` when
# available; otherwise clears <dst> and falls back to the same tar pipe as
# copy_tree.
copy_tree_mirror() {
  local src="$1" dst="$2"
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$src"/ "$dst"/
  else
    find "$dst" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    tar -C "$src" -cf - . | tar -C "$dst" -xf -
  fi
}

# require_port_from_env_file <env-file> <dry-run>
# Resolves $PORT strictly from <env-file>: unsets any ambient $PORT first,
# then sources the file, so a PORT already exported by the calling shell
# can never silently win over the file. Both the Debian and ZimaOS native
# routes are designed around "change one line in the env file and
# restart"; PORT is the one variable that design depends on never being
# inheritable. Leaves the resolved value in $PORT for the caller.
# If the file does not set PORT: under dry-run, logs a note and leaves a
# readable placeholder in $PORT so --dry-run output still has something to
# print; otherwise dies rather than guessing a default.
require_port_from_env_file() {
  local env_file="$1" dry_run="${2:-0}"
  unset PORT
  if [[ -f "$env_file" ]]; then
    # shellcheck disable=SC1090
    source "$env_file"
  fi
  if [[ -z "${PORT:-}" ]]; then
    if [[ "$dry_run" == "1" ]]; then
      log "[dry-run] $env_file does not set PORT (or does not exist yet); using a placeholder for this plan"
      PORT="<PORT from $env_file>"
    else
      die "$env_file does not set PORT (or the file is missing). Refusing to guess -- set PORT explicitly in the env file."
    fi
  fi
}

# resolve_or_placeholder <placeholder-text> <resolver-fn> [args...]
# Under --dry-run, prints the placeholder instead of calling the resolver, so
# the dry run never needs real disks/UUIDs/boot entries to produce its plan.
# In a real run, calls through to the resolver and prints its real output.
resolve_or_placeholder() {
  local placeholder="$1"
  shift
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '%s\n' "$placeholder"
  else
    "$@"
  fi
}

# DROP_PRIV_HELPER, set by resolve_drop_privileges_helper() below, caches the
# choice for the life of the process so the detection only runs once and the
# choice gets logged exactly once per script.
DROP_PRIV_HELPER=""

# setpriv_supports_util_linux_flags
# ZimaOS ships a cut-down `setpriv` that is on PATH but implements a
# different option set (BusyBox uses `--ruid`/`--euid`) and rejects
# util-linux's `--reuid` outright. A `command -v setpriv` existence check
# therefore selects a helper that can never run, which is exactly how the
# first real board install died: `setpriv: unrecognized option '--reuid'`,
# three seconds in. So probe the flags the setpriv branch of drop_priv_run()
# actually passes, against the caller's own uid/gid, which is a no-op switch.
# The probe deliberately uses only bash builtins ($EUID, $GROUPS) and no
# `id`/`grep`, so that it can only ever fail because of setpriv itself and
# never because of a thin PATH.
setpriv_supports_util_linux_flags() {
  local out lowered
  if out="$(setpriv --reuid "$EUID" --regid "${GROUPS[0]}" --init-groups --inh-caps=-all true 2>&1)"; then
    return 0
  fi
  # An option-parsing complaint means the flags are not implemented here, so
  # this setpriv can never work. Any other failure -- notably EPERM when the
  # probe itself runs unprivileged -- says nothing about flag support, and
  # the real call always runs as root, so keep setpriv in that case rather
  # than demoting a working helper on the strength of a permission error.
  lowered="${out,,}"
  case "$lowered" in
    *"unrecognized option"*|*"invalid option"*|*"unknown option"*|*"usage: setpriv"*|*busybox*)
      return 1
      ;;
  esac
  return 0
}

# python3_drop_priv_available
# The real board (TOM-278 host survey) has none of runuser/setpriv(util-linux
# flags)/su usable, but does have python3 on PATH. This probes that python3
# is present and that its stdlib `os`/`pwd` modules import cleanly -- the only
# two modules the fallback below needs -- so a broken or stripped-down python3
# build is rejected here rather than failing deep inside drop_priv_run().
python3_drop_priv_available() {
  command -v python3 >/dev/null 2>&1 && python3 -c 'import os, pwd' >/dev/null 2>&1
}

# resolve_c_compiler
# Probes for a usable C compiler, in the same existence-check style as the
# runuser/su arms of resolve_drop_privileges_helper() below -- tried in this
# order: $CC (if set), cc, gcc. Unlike that function's setpriv arm, there is
# no cut-down variant to screen out here: a C compiler either resolves on
# PATH or it doesn't. Sets C_COMPILER to the resolved name, or "" if none is
# found -- never dies, because no compiler is an expected, handled case
# (TOM-283), not a fatal one. Shared by install-native-zimaos.sh and
# paperclip-update.sh (TOM-286): both use it to decide whether to exclude
# @paperclipai/tailscale-https-broker from the release build.
C_COMPILER=""
resolve_c_compiler() {
  if [[ -n "${CC:-}" ]] && command -v "$CC" >/dev/null 2>&1; then
    C_COMPILER="$CC"
  elif command -v cc >/dev/null 2>&1; then
    C_COMPILER="cc"
  elif command -v gcc >/dev/null 2>&1; then
    C_COMPILER="gcc"
  else
    # shellcheck disable=SC2034 # read by install-native-zimaos.sh/paperclip-update.sh after sourcing this file
    C_COMPILER=""
  fi
}

# resolve_drop_privileges_helper
# ZimaOS has no package manager and the real board's PATH is missing
# `runuser` (confirmed by host reconnaissance, TOM-264/TOM-265) and `su`, and
# its `setpriv` is a cut-down build that lacks the util-linux flags this
# script needs (TOM-278 host survey). Detects, once, the best available way
# to run a command as an unprivileged user, tried in this order: `runuser`,
# `setpriv`, `su`, `python3`. Dies naming all four only if none exists. Call
# this before drop_priv_run(); it is idempotent.
#
# `runuser` and `su` are existence-checked only: both take the argv/command
# form used below in every implementation, and neither has a competing
# cut-down variant in play. `setpriv` is flag-probed, because it does.
# `python3` is probed for the two stdlib modules the fallback needs, for the
# same reason.
resolve_drop_privileges_helper() {
  [[ -n "$DROP_PRIV_HELPER" ]] && return 0
  if command -v runuser >/dev/null 2>&1; then
    DROP_PRIV_HELPER="runuser"
  elif command -v setpriv >/dev/null 2>&1 && setpriv_supports_util_linux_flags; then
    DROP_PRIV_HELPER="setpriv"
  elif command -v su >/dev/null 2>&1; then
    DROP_PRIV_HELPER="su"
  elif python3_drop_priv_available; then
    DROP_PRIV_HELPER="python3"
  else
    die "No usable privilege-drop helper found (tried: runuser, setpriv with util-linux --reuid/--regid/--init-groups/--inh-caps, su, python3 with stdlib os/pwd). Cannot run a command as an unprivileged user on this host."
  fi
  log "Privilege-drop helper resolved: $DROP_PRIV_HELPER"
}

# drop_priv_argv <user> -- <command...>
# Sets DROP_PRIV_ARGV to an external argv that runs <command...> as <user>,
# using whichever helper resolve_drop_privileges_helper() picked (called
# here if not already resolved). An argv, not a function call, so
# run_memory_guarded() can start it inside its own scope and process group.
# The `su -c` branch takes a single string, not argv, so each argument is
# quoted with `printf '%q'` and joined -- never spliced unescaped into the
# string -- before being handed to `su -c`. Under --dry-run it only records
# a readable placeholder, so a plan never depends on this host's helpers.
drop_priv_argv() {
  local user="$1"
  shift
  if [[ "${1:-}" != "--" ]]; then
    die "drop_priv_argv(): expected '--' before the command, got '${1:-}'"
  fi
  shift
  if [[ "$DRY_RUN" == "1" ]]; then
    DROP_PRIV_ARGV=("<run-as:$user>" "$@")
    return 0
  fi
  resolve_drop_privileges_helper
  case "$DROP_PRIV_HELPER" in
    runuser)
      DROP_PRIV_ARGV=(runuser -u "$user" -- "$@")
      ;;
    setpriv)
      local target_uid target_gid
      target_uid="$(id -u "$user")" || die "Could not resolve uid for user '$user'"
      target_gid="$(id -g "$user")" || die "Could not resolve gid for user '$user'"
      # --inh-caps=-all (not --inherit-caps, which util-linux does not
      # implement as a flag name on any version checked) drops inheritable
      # capabilities for defense in depth once uid/gid have already dropped.
      DROP_PRIV_ARGV=(setpriv --reuid "$target_uid" --regid "$target_gid" --init-groups --inh-caps=-all "$@")
      ;;
    su)
      local quoted_cmd="" arg
      for arg in "$@"; do
        quoted_cmd+="$(printf '%q ' "$arg")"
      done
      DROP_PRIV_ARGV=(su -s /bin/bash -c "$quoted_cmd" "$user")
      ;;
    python3)
      # Unlike the `su` branch above, this hands "$@" to python3 as discrete
      # argv entries (execvp, not a shell -c string), so there is no
      # string round trip to quote against -- the same reason the `runuser`
      # and `setpriv` branches above need no quoting either. Applying `%q`
      # quoting here would corrupt the argv instead of protecting it: the
      # escaped text (e.g. a literal `\ ` for a space) would reach the
      # command as-is, which is exactly the bug this script exists to avoid.
      DROP_PRIV_ARGV=(python3 -c '
import os, pwd, sys
pw = pwd.getpwnam(sys.argv[1])
os.setgid(pw.pw_gid)
os.initgroups(pw.pw_name, pw.pw_gid)
os.setuid(pw.pw_uid)
os.execvp(sys.argv[2], sys.argv[2:])
' "$user" "$@")
      ;;
    *)
      die "drop_priv_argv(): unknown DROP_PRIV_HELPER '$DROP_PRIV_HELPER'"
      ;;
  esac
}

# drop_priv_run <user> -- <command...>
# Runs <command...> as <user> in the foreground (see drop_priv_argv).
drop_priv_run() {
  local user="$1"
  shift
  if [[ "${1:-}" != "--" ]]; then
    die "drop_priv_run(): expected '--' before the command, got '${1:-}'"
  fi
  shift
  DRY_RUN=0 drop_priv_argv "$user" -- "$@"
  "${DROP_PRIV_ARGV[@]}"
}

# resolve_recovery_base <preferred> <fallback>
# Prints <preferred> if a real write test under it succeeds (creating
# scripts/ and lib/ subdirectories and a test file), otherwise prints
# <fallback>. Pulled out of install-native-zimaos.sh as its own function so
# an offline test can exercise the fallback branch (preferred unwritable)
# without needing root or a real /usr/local/lib on a throwaway host.
resolve_recovery_base() {
  local preferred="$1" fallback="$2"
  if mkdir -p "$preferred/scripts" "$preferred/lib" 2>/dev/null \
      && touch "$preferred/.write-test" 2>/dev/null; then
    rm -f "$preferred/.write-test"
    printf '%s\n' "$preferred"
  else
    printf '%s\n' "$fallback"
  fi
}
