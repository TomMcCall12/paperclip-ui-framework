#!/usr/bin/env bash
# Offline test for drop_priv_run()'s argument handling on the `su` branch.
#
# test-drop-priv-helper-fallback.sh covers *which* helper gets picked. This
# covers what happens to the command's arguments once `su` is the pick, which
# is the only branch that cannot pass argv through untouched: `su -c` takes a
# single shell string, so drop_priv_run has to quote every argument and join
# them, and a shell re-splits that string on the far side.
#
# This matters concretely rather than theoretically. The real board's mount
# path is "/DATA/.media/External SSD" -- it contains a space -- and every
# drop_priv_run call site passes BUILD_ENV entries built from it
# (HOME=<root>/home, TMPDIR=<root>/home/.tmp, PATH=<root>/toolchain/node/bin:...).
# If the join lost or re-split a single one of those, the build would run with
# a truncated HOME/PATH and fail somewhere far away from the real cause.
#
# Root is not needed: a stub `su` placed first on PATH stands in for the real
# one, parses the argv the real `su` would receive, and runs the -c string
# through bash exactly as `su -s /bin/bash -c` would. The command it ends up
# running prints its own argv back one entry per line, so the test compares
# the argv drop_priv_run was given against the argv that survived the round
# trip through the quoted string.
#
# The `setpriv` and `runuser` branches are not covered here: both pass "$@"
# straight through as argv with no string round trip, so there is nothing to
# quote and nothing to lose. Their exec paths need root (confirmed in this
# sandbox) and are proven on the host, not offline.
#
# The `python3` branch (TOM-278) is covered below, separately: it also
# passes "$@" straight through as discrete argv entries to python3 (execvp,
# not a shell -c string), so it is proven the same way the `su` branch is --
# round-tripped through a stand-in for the real interpreter -- rather than
# asserted to need no quoting on the strength of comments alone.
#
# Usage: test-drop-priv-run-quoting.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIMAOS_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
NATIVE_DIR="$(cd "$ZIMAOS_DIR/.." && pwd)"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(make_exec_capable_tempdir paperclip-drop-priv-quoting-test "$NATIVE_DIR")"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# A stub `su`, first on PATH, standing in for the real one. It asserts it was
# called the way drop_priv_run calls `su` (-s <shell> -c <string> <user>),
# records the user it was asked to switch to, and then runs the -c string
# through bash -- the same thing the real `su -s /bin/bash -c` does once it
# has dropped privileges.
STUB_BIN="$WORKDIR/stub-bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/su" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
shell="" cmd="" user="" saw_c=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -s) shell="$2"; shift 2 ;;
    -c) cmd="$2"; saw_c=1; shift 2 ;;
    *)  user="$1"; shift ;;
  esac
done
[[ "$saw_c" == "1" ]] || { echo "stub su: called without -c" >&2; exit 64; }
[[ -n "$user" ]] || { echo "stub su: called without a target user" >&2; exit 64; }
[[ -n "$shell" ]] || { echo "stub su: called without -s <shell>" >&2; exit 64; }
printf '%s\n' "$user" > "$STUB_SU_USER_FILE"
exec bash -c "$cmd"
STUB
chmod +x "$STUB_BIN/su"

# The command drop_priv_run will be asked to run: prints its own argv, one
# entry per line, so an argument that got split, joined or mangled shows up
# as a mismatched line rather than silently passing.
ECHO_ARGV="$WORKDIR/echo-argv.sh"
cat > "$ECHO_ARGV" <<'ARGV'
#!/usr/bin/env bash
for a in "$@"; do printf '%s\n' "$a"; done
ARGV
chmod +x "$ECHO_ARGV"

export STUB_SU_USER_FILE="$WORKDIR/su-user"

# Force the `su` branch directly. DROP_PRIV_HELPER is the documented cache
# resolve_drop_privileges_helper() fills in, and presetting it is how a
# caller pins a branch without having to mask two real binaries out of PATH.
DROP_PRIV_HELPER="su"
PATH="$STUB_BIN:$PATH"

# Arguments chosen to break a naive join: the real board's root with its
# space, then the characters a shell would otherwise act on -- single and
# double quotes, $, backtick, glob, semicolon, backslash, a tab, a newline,
# and an empty string.
ROOT_WITH_SPACE="/DATA/.media/External SSD/paperclip-native"
# shellcheck disable=SC2016  # The single quotes are the point: these entries
# must stay literal '$HOME', '${BRACED}' and '`whoami`' so the test proves
# drop_priv_run hands them to su without the far-side shell expanding them.
# Letting them expand here would delete exactly what is being tested.
EXPECTED_ARGV=(
  "HOME=$ROOT_WITH_SPACE/home"
  "TMPDIR=$ROOT_WITH_SPACE/home/.tmp"
  "PATH=$ROOT_WITH_SPACE/toolchain/node/bin:/usr/bin:/usr/sbin"
  "single'quote"
  'double"quote'
  'dollar$HOME and ${BRACED}'
  'backtick`whoami`'
  'glob* and ?'
  'semi;colon && pipe |'
  'back\slash'
  "$(printf 'tab\tseparated')"
  "$(printf 'line1\nline2')"
  ""
)

actual_output="$(drop_priv_run paperclip -- "$ECHO_ARGV" "${EXPECTED_ARGV[@]}")"

# Compare line by line. The echoed argv prints one entry per line, so the
# expected form is the same entries joined by newlines -- which also means an
# argument that itself contains a newline is expected to arrive as two lines.
expected_output="$(printf '%s\n' "${EXPECTED_ARGV[@]}")"
expected_output="${expected_output%$'\n'}"

if [[ "$actual_output" != "$expected_output" ]]; then
  echo "--- expected argv ---" >&2
  printf '%s\n' "$expected_output" | cat -A >&2
  echo "--- actual argv ---" >&2
  printf '%s\n' "$actual_output" | cat -A >&2
  fail "drop_priv_run's su branch did not round-trip the argv unchanged"
fi
echo "PASS: the su branch round-trips argv unchanged (spaces, quotes, \$, backtick, glob, backslash, tab, newline, empty)"

# The target user must reach `su` as its own argument, not folded into the
# command string.
got_user="$(cat "$STUB_SU_USER_FILE")"
[[ "$got_user" == "paperclip" ]] || fail "expected su to be asked to switch to 'paperclip', got '$got_user'"
echo "PASS: the target user is passed to su as its own argument"

# A non-zero exit from the command must surface, not be swallowed by the
# quoting layer -- the install gates rely on a failed build failing the run.
set +e
drop_priv_run paperclip -- bash -c 'exit 42' >/dev/null 2>&1
rc=$?
set -e
[[ "$rc" -eq 42 ]] || fail "expected the command's exit status 42 to propagate through the su branch, got '$rc'"
echo "PASS: the command's exit status propagates through the su branch"

# The '--' separator contract is enforced, so a mistyped call site fails
# loudly instead of silently treating the command as the username.
set +e
err_output="$(drop_priv_run paperclip bash -c 'true' 2>&1)"
rc=$?
set -e
[[ "$rc" -ne 0 ]] || fail "drop_priv_run should reject a call with no '--' separator, but exited 0"
[[ "$err_output" == *"--"* ]] || fail "the missing-'--' error should mention the separator (got: $err_output)"
echo "PASS: a call missing the '--' separator is rejected"

# --- python3 branch (TOM-278) ----------------------------------------------
# A stub `python3`, standing in for the real one. It asserts it was called
# the way drop_priv_run calls python3 (-c <script> <user> <cmd> <args...>),
# records the user it was asked to switch to, then skips the actual
# setuid/setgid (this sandbox is not root) and execs the command with its
# argv untouched -- proving drop_priv_run's python3 branch hands "$@"
# through as discrete argv entries rather than joining them into a string.
cat > "$STUB_BIN/python3" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "-c" ]] || { echo "stub python3: expected -c as the first argument" >&2; exit 64; }
shift 2
user="${1:-}"
[[ -n "$user" ]] || { echo "stub python3: called without a target user" >&2; exit 64; }
shift
printf '%s\n' "$user" > "$STUB_PY_USER_FILE"
exec "$@"
STUB
chmod +x "$STUB_BIN/python3"

export STUB_PY_USER_FILE="$WORKDIR/python3-user"
DROP_PRIV_HELPER="python3"

actual_output="$(drop_priv_run paperclip -- "$ECHO_ARGV" "${EXPECTED_ARGV[@]}")"
if [[ "$actual_output" != "$expected_output" ]]; then
  echo "--- expected argv ---" >&2
  printf '%s\n' "$expected_output" | cat -A >&2
  echo "--- actual argv ---" >&2
  printf '%s\n' "$actual_output" | cat -A >&2
  fail "drop_priv_run's python3 branch did not round-trip the argv unchanged"
fi
echo "PASS: the python3 branch round-trips argv unchanged (spaces, quotes, \$, backtick, glob, backslash, tab, newline, empty)"

got_user="$(cat "$STUB_PY_USER_FILE")"
[[ "$got_user" == "paperclip" ]] || fail "expected python3 to be asked to switch to 'paperclip', got '$got_user'"
echo "PASS: the target user is passed to the python3 helper as its own argument"

set +e
drop_priv_run paperclip -- bash -c 'exit 42' >/dev/null 2>&1
rc=$?
set -e
[[ "$rc" -eq 42 ]] || fail "expected the command's exit status 42 to propagate through the python3 branch, got '$rc'"
echo "PASS: the command's exit status propagates through the python3 branch"

echo "All drop-priv-run quoting test cases passed."
