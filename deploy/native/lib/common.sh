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

# mem_available_mb
# Reads /proc/meminfo's MemAvailable directly (kB -> MB), never `free`'s
# output: MemAvailable already excludes reclaimable-but-unusable memory, and
# avoids depending on `free` being installed. Swap is never counted -- a
# build that only "fits" in swap thrashes instead of finishing.
mem_available_mb() {
  local kb
  kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
  [[ -n "$kb" ]] || die "Could not read MemAvailable from /proc/meminfo."
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

# run_memory_guarded <description> <min-mb> <poll-seconds> -- <command...>
# Runs <command...> in the background and polls MemAvailable every
# <poll-seconds>; if it drops below <min-mb> while the command is still
# running, kills the command and dies (BUILD_EXIT=91-class failure: the
# build started fine but the host ran low partway through, e.g. another
# process competing for RAM). Honors DRY_RUN via run().
run_memory_guarded() {
  local desc="$1" min_mb="$2" poll_seconds="$3"
  shift 3
  if [[ "${1:-}" != "--" ]]; then
    die "run_memory_guarded(): expected '--' before the command, got '${1:-}'"
  fi
  shift
  if [[ "$DRY_RUN" == "1" ]]; then
    print_dry_run_command "$desc (memory-guarded: abort if MemAvailable < ${min_mb}MB, checked every ${poll_seconds}s)" "$@"
    return 0
  fi
  log "$desc (memory-guarded: abort if MemAvailable < ${min_mb}MB)"
  "$@" &
  local cmd_pid=$! watchdog_tripped=0 avail
  while kill -0 "$cmd_pid" 2>/dev/null; do
    avail="$(mem_available_mb)"
    if [[ "$avail" -lt "$min_mb" ]]; then
      log "WATCHDOG: avail=${avail}MB < ${min_mb}MB, cancelling: $desc"
      kill "$cmd_pid" 2>/dev/null || true
      watchdog_tripped=1
      break
    fi
    sleep "$poll_seconds"
  done
  if [[ "$watchdog_tripped" == "1" ]]; then
    wait "$cmd_pid" 2>/dev/null || true
    die "$desc aborted: memory dropped below ${min_mb}MB mid-run (BUILD_EXIT=91-class failure). Free memory and retry."
  fi
  wait "$cmd_pid"
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

# drop_priv_run <user> -- <command...>
# Runs <command...> as <user>, using whichever helper
# resolve_drop_privileges_helper() picked (called here if not already
# resolved). The `su -c` branch takes a single string, not argv, so each
# argument is quoted with `printf '%q'` and joined -- never spliced
# unescaped into the string -- before being handed to `su -c`.
drop_priv_run() {
  local user="$1"
  shift
  if [[ "${1:-}" != "--" ]]; then
    die "drop_priv_run(): expected '--' before the command, got '${1:-}'"
  fi
  shift
  resolve_drop_privileges_helper
  case "$DROP_PRIV_HELPER" in
    runuser)
      runuser -u "$user" -- "$@"
      ;;
    setpriv)
      local target_uid target_gid
      target_uid="$(id -u "$user")" || die "Could not resolve uid for user '$user'"
      target_gid="$(id -g "$user")" || die "Could not resolve gid for user '$user'"
      # --inh-caps=-all (not --inherit-caps, which util-linux does not
      # implement as a flag name on any version checked) drops inheritable
      # capabilities for defense in depth once uid/gid have already dropped.
      setpriv --reuid "$target_uid" --regid "$target_gid" --init-groups --inh-caps=-all "$@"
      ;;
    su)
      local quoted_cmd="" arg
      for arg in "$@"; do
        quoted_cmd+="$(printf '%q ' "$arg")"
      done
      su -s /bin/bash -c "$quoted_cmd" "$user"
      ;;
    python3)
      # Unlike the `su` branch above, this hands "$@" to python3 as discrete
      # argv entries (execvp, not a shell -c string), so there is no
      # string round trip to quote against -- the same reason the `runuser`
      # and `setpriv` branches above need no quoting either. Applying `%q`
      # quoting here would corrupt the argv instead of protecting it: the
      # escaped text (e.g. a literal `\ ` for a space) would reach the
      # command as-is, which is exactly the bug this script exists to avoid.
      python3 -c '
import os, pwd, sys
pw = pwd.getpwnam(sys.argv[1])
os.setgid(pw.pw_gid)
os.initgroups(pw.pw_name, pw.pw_gid)
os.setuid(pw.pw_uid)
os.execvp(sys.argv[2], sys.argv[2:])
' "$user" "$@"
      ;;
    *)
      die "drop_priv_run(): unknown DROP_PRIV_HELPER '$DROP_PRIV_HELPER'"
      ;;
  esac
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
