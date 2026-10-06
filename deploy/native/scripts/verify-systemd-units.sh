#!/usr/bin/env bash
# Run `systemd-analyze verify` against every unit in deploy/native/systemd/,
# without needing a real paperclip user, /srv/paperclip, or /usr/bin/node on
# the machine running this check.
#
# `systemd-analyze verify --root=<dir>` confines path resolution strictly
# inside <dir> (it will not follow ".." or an absolute symlink back out to
# the real filesystem -- that just spins until the symlink-depth limit), so
# the fake root below uses real files, not symlinks, for anything systemd
# actually reads: a copy of /usr/lib/systemd/system (default targets the
# Wants=/After= graph needs), stub executables for every ExecStart binary,
# and a passwd/group entry for the `paperclip` user referenced by User=.
#
# Run this from a directory on an exec-capable filesystem (not /tmp on a
# system that mounts it noexec) -- the stub binaries must actually be
# executable for the check to mean anything.
#
# Usage: verify-systemd-units.sh [--keep]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

# Prefer $TMPDIR, but it must actually allow executing files (some hosts
# mount /tmp noexec, which would make every stub binary below unusable).
FAKEROOT="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-systemd-verify.XXXXXX")"
printf '#!/bin/sh\n' > "$FAKEROOT/.exectest"
chmod +x "$FAKEROOT/.exectest"
if ! "$FAKEROOT/.exectest" 2>/dev/null; then
  rm -rf "$FAKEROOT"
  FAKEROOT="$(mktemp -d "$NATIVE_DIR/.verify-fakeroot.XXXXXX")"
fi
rm -f "$FAKEROOT/.exectest"

# shellcheck disable=SC2317  # invoked indirectly via `trap ... EXIT` below
cleanup() {
  [[ "$KEEP" == "1" ]] && { log "Keeping fakeroot at $FAKEROOT"; return; }
  rm -rf "$FAKEROOT"
}
trap cleanup EXIT

log "Building verification fakeroot at $FAKEROOT"
mkdir -p "$FAKEROOT/dev" "$FAKEROOT/proc" "$FAKEROOT/sys" "$FAKEROOT/run" "$FAKEROOT/tmp"
: > "$FAKEROOT/dev/null"

mkdir -p "$FAKEROOT/usr/lib"
cp -rL /usr/lib/systemd "$FAKEROOT/usr/lib/systemd" 2>/dev/null || true

mkdir -p "$FAKEROOT/usr/bin"
for stub in node bash sh env rsync curl runuser sudo systemctl journalctl; do
  printf '#!/bin/sh\n' > "$FAKEROOT/usr/bin/$stub"
  chmod +x "$FAKEROOT/usr/bin/$stub"
done

mkdir -p "$FAKEROOT/etc/systemd/system"
cp "$NATIVE_DIR"/systemd/*.service "$NATIVE_DIR"/systemd/*.timer "$FAKEROOT/etc/systemd/system/"
cp /etc/passwd "$FAKEROOT/etc/passwd"
echo "paperclip:x:2000:2000::/srv/paperclip:/usr/sbin/nologin" >> "$FAKEROOT/etc/passwd"
cp /etc/group "$FAKEROOT/etc/group"
echo "paperclip:x:2000:" >> "$FAKEROOT/etc/group"

mkdir -p "$FAKEROOT/srv/paperclip/current/deploy/native/scripts" \
         "$FAKEROOT/srv/paperclip/current/docker/notes-vault-bridge" \
         "$FAKEROOT/srv/paperclip/env" \
         "$FAKEROOT/srv/hdd"
for f in paperclip-backup.sh paperclip-watchdog.sh vault-drive-sync.sh telegram-alert.sh; do
  printf '#!/usr/bin/env bash\n' > "$FAKEROOT/srv/paperclip/current/deploy/native/scripts/$f"
  chmod +x "$FAKEROOT/srv/paperclip/current/deploy/native/scripts/$f"
done
for f in paperclip.env telegram.env notes-vault-bridge.env rclone.env; do
  touch "$FAKEROOT/srv/paperclip/env/$f"
done

status=0
for unit_path in "$NATIVE_DIR"/systemd/*.service "$NATIVE_DIR"/systemd/*.timer; do
  unit="$(basename "$unit_path")"
  echo "== $unit =="
  output="$(systemd-analyze verify --root="$FAKEROOT" "$unit" 2>&1)"
  unit_status=$?
  printf '%s\n' "$output" | grep -v 'is not a symlink, ignoring' || true
  [[ "$unit_status" -ne 0 ]] && status=1
done

exit "$status"
