#!/usr/bin/env bash
# Run `systemd-analyze verify` against a directory of unit files, without
# needing a real paperclip user, install root, or /usr/bin/node on the
# machine running this check.
#
# `systemd-analyze verify --root=<dir>` confines path resolution strictly
# inside <dir> (it will not follow ".." or an absolute symlink back out to
# the real filesystem -- that just spins until the symlink-depth limit), so
# the fake root below uses real files, not symlinks, for anything systemd
# actually reads: a copy of /usr/lib/systemd/system (default targets the
# Wants=/After= graph needs), stub executables for every ExecStart binary
# and EnvironmentFile referenced *by the unit files themselves* (so this
# script needs no hand-maintained, unit-set-specific path list), and a
# passwd/group entry for the `paperclip` user referenced by User=.
#
# Run this from a directory on an exec-capable filesystem (not /tmp on a
# system that mounts it noexec) -- the stub binaries must actually be
# executable for the check to mean anything.
#
# This stubs a file at every path a unit *names*, so it cannot catch a
# *real* pre-stage forgetting to put the real file there -- see
# check-execstart-targets.sh for that check, which runs against the actual
# staged target instead of a hand-made stand-in.
#
# Usage: verify-systemd-units.sh [--units-dir <dir>] [--keep]
#
# --units-dir defaults to this script's own ../systemd (the Debian unit
# set); pass deploy/native/zimaos/systemd to check the ZimaOS unit set
# instead. Works on any directory of *.service/*.timer files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

UNITS_DIR="$NATIVE_DIR/systemd"
KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --units-dir) UNITS_DIR="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

UNITS_DIR="$(cd "$UNITS_DIR" && pwd)" || die "--units-dir does not exist"

# Prefer $TMPDIR, but it must actually allow executing files (some hosts
# mount /tmp noexec, which would make every stub binary below unusable).
FAKEROOT="$(make_exec_capable_tempdir paperclip-systemd-verify "$NATIVE_DIR")"

# shellcheck disable=SC2317  # invoked indirectly via `trap ... EXIT` below
cleanup() {
  [[ "$KEEP" == "1" ]] && { log "Keeping fakeroot at $FAKEROOT"; return; }
  rm -rf "$FAKEROOT"
}
trap cleanup EXIT

log "Building verification fakeroot at $FAKEROOT for units in $UNITS_DIR"
mkdir -p "$FAKEROOT/dev" "$FAKEROOT/proc" "$FAKEROOT/sys" "$FAKEROOT/run" "$FAKEROOT/tmp" "$FAKEROOT/boot/efi"
: > "$FAKEROOT/dev/null"

mkdir -p "$FAKEROOT/usr/lib"
cp -rL /usr/lib/systemd "$FAKEROOT/usr/lib/systemd" 2>/dev/null || true

mkdir -p "$FAKEROOT/usr/bin"
for stub in node bash sh env rsync curl runuser sudo systemctl journalctl; do
  printf '#!/bin/sh\n' > "$FAKEROOT/usr/bin/$stub"
  chmod +x "$FAKEROOT/usr/bin/$stub"
done

mkdir -p "$FAKEROOT/etc/systemd/system"
cp "$UNITS_DIR"/*.service "$UNITS_DIR"/*.timer "$FAKEROOT/etc/systemd/system/" 2>/dev/null || true
cp /etc/passwd "$FAKEROOT/etc/passwd"
echo "paperclip:x:2000:2000::/srv/paperclip:/usr/sbin/nologin" >> "$FAKEROOT/etc/passwd"
cp /etc/group "$FAKEROOT/etc/group"
echo "paperclip:x:2000:" >> "$FAKEROOT/etc/group"

# stub_path_in_fakeroot <absolute-path>
# Creates an executable stub (for anything that looks like a binary, i.e.
# every path this is called with) at <absolute-path> inside $FAKEROOT.
stub_path_in_fakeroot() {
  local path="$1" full="$FAKEROOT$1"
  [[ "$path" == /* ]] || return 0
  mkdir -p "$(dirname "$full")"
  [[ -e "$full" ]] && return 0
  printf '#!/usr/bin/env bash\n' > "$full"
  chmod +x "$full"
}

# touch_path_in_fakeroot <absolute-path>
# Creates an empty file at <absolute-path> inside $FAKEROOT (for
# EnvironmentFile= targets, which only need to exist, not be executable).
touch_path_in_fakeroot() {
  local path="$1" full="$FAKEROOT$1"
  [[ "$path" == /* ]] || return 0
  mkdir -p "$(dirname "$full")"
  touch "$full"
}

shopt -s nullglob
unit_files=("$UNITS_DIR"/*.service "$UNITS_DIR"/*.timer)
[[ ${#unit_files[@]} -gt 0 ]] || die "No *.service/*.timer files found under $UNITS_DIR"

for unit_path in "${unit_files[@]}"; do
  while IFS= read -r line; do
    case "$line" in
      ExecStart=*|ExecStartPre=*|ExecStartPost=*|ExecStop=*)
        raw="${line#Exec*=}"
        raw="$(printf '%s' "$raw" | sed -E 's/^[-+!]*//')"
        bin="${raw%% *}"
        stub_path_in_fakeroot "$bin"
        ;;
      EnvironmentFile=*)
        raw="${line#EnvironmentFile=}"
        raw="${raw#-}"
        touch_path_in_fakeroot "$raw"
        ;;
      WorkingDirectory=*)
        raw="${line#WorkingDirectory=}"
        [[ "$raw" == /* ]] && mkdir -p "$FAKEROOT$raw"
        ;;
    esac
  done < "$unit_path"
done

status=0
for unit_path in "${unit_files[@]}"; do
  [[ -e "$unit_path" ]] || continue
  unit="$(basename "$unit_path")"
  echo "== $unit =="
  output="$(systemd-analyze verify --root="$FAKEROOT" "$unit" 2>&1)"
  unit_status=$?
  printf '%s\n' "$output" | grep -v 'is not a symlink, ignoring' || true
  [[ "$unit_status" -ne 0 ]] && status=1
done

exit "$status"
