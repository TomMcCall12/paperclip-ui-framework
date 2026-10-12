#!/usr/bin/env bash
# Offline test for resolve_recovery_base() (TOM-265 item 5/3). Host
# reconnaissance confirmed /usr/local/lib does not exist and cannot be
# created on the real board, so install-native-zimaos.sh's <root>/recovery
# fallback branch is the one that will actually run there -- not just a
# contingency path that happens to be present in the code. This proves
# that fallback branch fires when the preferred base is not writable, and
# that the preferred base is still chosen when it is.
#
# Usage: test-recovery-base-fallback.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIMAOS_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
NATIVE_DIR="$(cd "$ZIMAOS_DIR/.." && pwd)"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(make_exec_capable_tempdir paperclip-recovery-base-test "$NATIVE_DIR")"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# --- Case 1: preferred base is writable -> preferred is chosen -------------
WRITABLE_PREFERRED="$WORKDIR/writable-preferred"
FALLBACK_1="$WORKDIR/fallback-1"
mkdir -p "$WRITABLE_PREFERRED"
got="$(resolve_recovery_base "$WRITABLE_PREFERRED" "$FALLBACK_1")"
[[ "$got" == "$WRITABLE_PREFERRED" ]] || fail "expected the writable preferred base to be chosen, got '$got'"
[[ -d "$WRITABLE_PREFERRED/scripts" && -d "$WRITABLE_PREFERRED/lib" ]] || fail "resolve_recovery_base did not create scripts/ and lib/ under the writable preferred base"
[[ ! -e "$WRITABLE_PREFERRED/.write-test" ]] || fail "resolve_recovery_base left its .write-test probe file behind"
echo "PASS: the preferred base is chosen (and scripts/lib created under it) when it is writable"

# --- Case 2: preferred base is NOT writable -> fallback is chosen ----------
# A read-only parent directory makes `mkdir -p <parent>/nested/scripts` fail
# the way a real unwritable /usr/local/lib does on the board -- this is the
# actual fallback branch exercised, not a stand-in for it.
READONLY_PARENT="$WORKDIR/readonly-parent"
mkdir -p "$READONLY_PARENT"
chmod 555 "$READONLY_PARENT"
trap 'chmod 755 "$READONLY_PARENT" 2>/dev/null || true; rm -rf "$WORKDIR"' EXIT
UNWRITABLE_PREFERRED="$READONLY_PARENT/nested/paperclip"
FALLBACK_2="$WORKDIR/fallback-2"
got="$(resolve_recovery_base "$UNWRITABLE_PREFERRED" "$FALLBACK_2")"
[[ "$got" == "$FALLBACK_2" ]] || fail "expected the fallback base to be chosen when the preferred base is not writable, got '$got'"
[[ ! -e "$UNWRITABLE_PREFERRED" ]] || fail "resolve_recovery_base should not have been able to create anything under the read-only parent"
echo "PASS: the fallback base is chosen when the preferred base cannot be written to (the real board's /usr/local/lib condition)"

echo "All recovery-base fallback test cases passed."
