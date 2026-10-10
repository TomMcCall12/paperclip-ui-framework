#!/usr/bin/env bash
# Offline test for the ambient-$PORT fix (TOM-265). The cutover design for
# both the Debian and ZimaOS native routes is "change one line in the env
# file and restart" -- so a PORT already exported in the calling shell must
# never silently win over the env file's PORT. Covers require_port_from_env_file
# (deploy/native/lib/common.sh), shared by paperclip-update.sh and
# paperclip-deploy:
#   1. End-to-end against the real paperclip-update.sh --dry-run (needs
#      neither root nor an actual install): an ambient PORT is REJECTED --
#      the env file's PORT is what ends up in the printed health-check URL.
#   2. Direct unit test of require_port_from_env_file: a missing/empty
#      PORT in the env file is NOT silently defaulted when not in
#      --dry-run mode -- it fails clearly instead of guessing. (Run via
#      the function directly, not the full script, because the full
#      non-dry-run path requires root, which this offline test must not
#      assume.)
#
# Usage: test-port-no-ambient-override.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIMAOS_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
NATIVE_DIR="$(cd "$ZIMAOS_DIR/.." && pwd)"
UPDATE_SCRIPT="$ZIMAOS_DIR/paperclip-update.sh"
COMMON_SH="$NATIVE_DIR/lib/common.sh"
# shellcheck source=../../../lib/common.sh
source "$COMMON_SH"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-port-test.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# --- Case 1: ambient PORT must not override the env file's PORT -----------
# End-to-end against the real script, under --dry-run (no root needed).
ROOT1="$WORKDIR/root-with-port"
mkdir -p "$ROOT1/env"
cat > "$ROOT1/env/paperclip-native.env" <<'EOF'
PORT=4242
EOF

OUT1="$WORKDIR/case1.log"
# Ambient PORT is deliberately different from the file's 4242, and
# deliberately exported (not just set) so it would be inherited by any
# child process/subshell if the fix did not work.
if ! PORT=9999 "$UPDATE_SCRIPT" --commit 0000000 --repo-src "$NATIVE_DIR" --root "$ROOT1" --dry-run > "$OUT1" 2>&1; then
  cat "$OUT1" >&2
  fail "Case 1: --dry-run should still exit 0 when the env file sets PORT, even with an ambient PORT exported"
fi
if grep -q '127\.0\.0\.1:9999' "$OUT1"; then
  fail "Case 1: ambient PORT=9999 leaked into the health-check URL -- the env file's PORT was not honored"
fi
if ! grep -q '127\.0\.0\.1:4242' "$OUT1"; then
  cat "$OUT1" >&2
  fail "Case 1: expected the health-check URL to use the env file's PORT=4242, not found in output above"
fi
echo "PASS: an ambient \$PORT is rejected in favor of the env file's PORT (end-to-end, paperclip-update.sh --dry-run)"

# --- Case 2: ambient PORT rejected, checked directly against the shared ---
# --- helper too (belt-and-suspenders unit coverage of the exact function) -
ENV_FILE2="$WORKDIR/env-with-port"
printf 'PORT=5151\n' > "$ENV_FILE2"
RESOLVED="$(PORT=8080 bash -c "source '$COMMON_SH'; require_port_from_env_file '$ENV_FILE2' 0; printf '%s' \"\$PORT\"")"
[[ "$RESOLVED" == "5151" ]] || fail "Case 2: require_port_from_env_file returned '$RESOLVED', expected the file's PORT=5151 (ambient PORT=8080 must be rejected)"
echo "PASS: require_port_from_env_file rejects an ambient \$PORT directly (unit-level)"

# --- Case 3: env file without PORT must fail clearly, not guess -----------
# Direct unit test of require_port_from_env_file in non-dry-run mode: the
# full script's non-dry-run path requires root (require_root), which this
# offline test must not assume, so exercise the exact shared function
# instead of the whole script.
ENV_FILE3="$WORKDIR/env-no-port"
printf 'HOST=0.0.0.0\n' > "$ENV_FILE3"
OUT3="$WORKDIR/case3.log"
set +e
env -u PORT bash -c "source '$COMMON_SH'; require_port_from_env_file '$ENV_FILE3' 0" > "$OUT3" 2>&1
case3_exit=$?
set -e
if [[ "$case3_exit" -eq 0 ]]; then
  cat "$OUT3" >&2
  fail "Case 3: expected a non-zero exit when the env file has no PORT (non-dry-run), got 0"
fi
if ! grep -qi 'does not set PORT' "$OUT3"; then
  cat "$OUT3" >&2
  fail "Case 3: expected a clear 'does not set PORT' error, not found in output above"
fi
echo "PASS: a missing PORT in the env file fails clearly instead of defaulting to a guessed value"

echo "All PORT-no-ambient-override test cases passed."
