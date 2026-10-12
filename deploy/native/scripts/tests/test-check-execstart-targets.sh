#!/usr/bin/env bash
# Offline test for check-execstart-targets.sh (TOM-224). Proves it passes
# when every ExecStart binary is present (including through a symlink, the
# release-tree pattern), and proves it FAILS when one is absent -- the
# exact bug class (paperclip-firstboot.service's ExecStart pointing at a
# release file that was never staged) that slipped past
# verify-systemd-units.sh's always-stub-everything fakeroot.
#
# Usage: test-check-execstart-targets.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
CHECK="$SCRIPTS_DIR/check-execstart-targets.sh"
# shellcheck source=../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

# The stub scripts below must actually be executable to mean anything --
# some hosts mount /tmp noexec.
WORKDIR="$(make_exec_capable_tempdir paperclip-check-execstart-test "$NATIVE_DIR")"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# --- Case 1: present, direct absolute path -> PASS -------------------------
ROOT1="$WORKDIR/root-ok"
UNITS1="$WORKDIR/units-ok"
mkdir -p "$ROOT1/usr/local/lib/paperclip/scripts" "$UNITS1"
printf '#!/bin/sh\n' > "$ROOT1/usr/local/lib/paperclip/scripts/paperclip-firstboot.sh"
chmod +x "$ROOT1/usr/local/lib/paperclip/scripts/paperclip-firstboot.sh"
cat > "$UNITS1/paperclip-firstboot.service" <<'EOF'
[Service]
ExecStart=/usr/local/lib/paperclip/scripts/paperclip-firstboot.sh
EOF

if ! "$CHECK" --root "$ROOT1" --units-dir "$UNITS1" > "$WORKDIR/case1.log" 2>&1; then
  cat "$WORKDIR/case1.log" >&2
  fail "Case 1 (file present) should pass, but check-execstart-targets.sh exited non-zero"
fi
echo "PASS: present ExecStart target is accepted"

# --- Case 2: present via a release-symlink-style indirection -> PASS -------
ROOT2="$WORKDIR/root-symlink"
UNITS2="$WORKDIR/units-symlink"
mkdir -p "$ROOT2/srv/paperclip/releases/abc123/deploy/native/scripts" "$UNITS2"
printf '#!/bin/sh\n' > "$ROOT2/srv/paperclip/releases/abc123/deploy/native/scripts/paperclip-backup.sh"
chmod +x "$ROOT2/srv/paperclip/releases/abc123/deploy/native/scripts/paperclip-backup.sh"
ln -s /srv/paperclip/releases/abc123 "$ROOT2/srv/paperclip/current"
cat > "$UNITS2/paperclip-backup.service" <<'EOF'
[Service]
ExecStart=/srv/paperclip/current/deploy/native/scripts/paperclip-backup.sh
EOF

if ! "$CHECK" --root "$ROOT2" --units-dir "$UNITS2"; then
  fail "Case 2 (file present through a release symlink) should pass"
fi
echo "PASS: ExecStart target reachable through a symlink is accepted"

# --- Case 3: ExecStart target MISSING -> FAIL -------------------------------
ROOT3="$WORKDIR/root-missing"
UNITS3="$WORKDIR/units-missing"
mkdir -p "$ROOT3/srv/paperclip/releases/abc123/deploy/native/scripts" "$UNITS3"
# Deliberately do NOT create paperclip-firstboot.sh -- this reproduces the
# real TOM-205 fault: the unit is wired up, but the release never shipped
# the file.
ln -s /srv/paperclip/releases/abc123 "$ROOT3/srv/paperclip/current"
cat > "$UNITS3/paperclip-firstboot.service" <<'EOF'
[Service]
ExecStart=/srv/paperclip/current/deploy/native/scripts/paperclip-firstboot.sh
EOF

if "$CHECK" --root "$ROOT3" --units-dir "$UNITS3" >/dev/null 2>&1; then
  fail "Case 3 (ExecStart target missing) should fail, but check-execstart-targets.sh exited 0"
fi
echo "PASS: missing ExecStart target is correctly rejected"

# --- Case 4: ExecStart target present but not executable -> FAIL -----------
ROOT4="$WORKDIR/root-not-exec"
UNITS4="$WORKDIR/units-not-exec"
mkdir -p "$ROOT4/usr/local/lib/paperclip/scripts" "$UNITS4"
printf '#!/bin/sh\n' > "$ROOT4/usr/local/lib/paperclip/scripts/paperclip-watchdog.sh"
# No chmod +x: present, but not executable.
cat > "$UNITS4/paperclip-watchdog.service" <<'EOF'
[Service]
ExecStart=/usr/local/lib/paperclip/scripts/paperclip-watchdog.sh
EOF

if "$CHECK" --root "$ROOT4" --units-dir "$UNITS4" >/dev/null 2>&1; then
  fail "Case 4 (ExecStart target not executable) should fail, but check-execstart-targets.sh exited 0"
fi
echo "PASS: non-executable ExecStart target is correctly rejected"

echo "All check-execstart-targets.sh test cases passed."
