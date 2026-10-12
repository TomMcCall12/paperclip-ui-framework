#!/usr/bin/env bash
# Offline test for resolve_drop_privileges_helper()/drop_priv_run() (TOM-265
# item 5, extended by TOM-278). The real board's root PATH
# (/usr/bin:/usr/sbin) has no `runuser` or `su` and only a cut-down `setpriv`
# -- confirmed by host reconnaissance -- so the installer and updater must
# not hard-require any of the first three. This proves the fallback chain
# picks the next available helper, in order runuser -> setpriv -> su ->
# python3, as each preceding one is masked out of PATH, and that
# resolve_drop_privileges_helper() dies naming all four only when none of
# them exist.
#
# It also covers the case the first real board install died on: a `setpriv`
# that is present but rejects util-linux's `--reuid`. Presence alone is not
# enough to pick it, so cases 5-7 pin the flag probe's three outcomes --
# flags rejected, flags accepted, probe refused on permissions. Cases 8-10
# cover the python3 fallback added for TOM-278: picked when runuser/
# setpriv/su are all absent, named in the all-helpers-absent error, and
# skipped (not just existence-checked) when present but missing the stdlib
# modules the fallback needs.
#
# This cannot exercise drop_priv_run()'s actual privilege-dropping exec path
# (runuser/setpriv/su/python3 all refuse to switch uid, even to the caller's
# own uid, without root -- confirmed in this sandbox), so it tests selection
# only: which helper resolve_drop_privileges_helper() picks, not that the
# picked helper's exec succeeds. That matches what TOM-265 asked for
# ("proves the next option in the chain gets picked").
#
# Usage: test-drop-priv-helper-fallback.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIMAOS_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
NATIVE_DIR="$(cd "$ZIMAOS_DIR/.." && pwd)"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(make_exec_capable_tempdir paperclip-drop-priv-test "$NATIVE_DIR")"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# curated_path <tool...>
# Builds a directory of symlinks to just the named tools (resolved from the
# real PATH), deliberately excluding anything not listed, then prints that
# directory's path. A curated symlink dir -- not a $PATH-entry filter --
# guarantees an excluded tool cannot be found via any PATH entry it happens
# to share with an included one.
curated_path() {
  local bindir="$WORKDIR/masked-bin.$RANDOM" tool resolved
  mkdir -p "$bindir"
  for tool in "$@" bash sh env cat mkdir rm touch date coreutils; do
    resolved="$(command -v "$tool" 2>/dev/null || true)"
    [[ -n "$resolved" ]] && ln -sf "$resolved" "$bindir/$tool"
  done
  printf '%s\n' "$bindir"
}

# stubbed_setpriv_path <stub-body> <tool...>
# Like curated_path, but `setpriv` is a script with the given body instead of
# a symlink to the host's real one. Lets the flag probe meet a chosen setpriv
# variant without root and without caring what this sandbox happens to ship.
stubbed_setpriv_path() {
  local body="$1"
  shift
  local bindir
  bindir="$(curated_path "$@")"
  printf '#!/usr/bin/env bash\n%s\n' "$body" >"$bindir/setpriv"
  chmod +x "$bindir/setpriv"
  printf '%s\n' "$bindir"
}

resolved_helper_under_path() {
  local masked_path="$1"
  # -u BASH_ENV: this sandbox sets BASH_ENV to a profile that force-resets
  # PATH to the real one on every non-interactive bash startup, which would
  # silently defeat the PATH mask below. Unset it for the nested bash so
  # the mask actually takes effect.
  env -u BASH_ENV PATH="$masked_path" bash -c "source '$NATIVE_DIR/lib/common.sh' && resolve_drop_privileges_helper && printf '%s' \"\$DROP_PRIV_HELPER\""
}

# --- Case 1: all three present -> runuser wins (first in the chain) -------
ALL_THREE="$(curated_path runuser setpriv su)"
got="$(resolved_helper_under_path "$ALL_THREE")"
[[ "$got" == "runuser" ]] || fail "expected 'runuser' to be picked when all three are present, got '$got'"
echo "PASS: runuser picked when runuser, setpriv and su are all present"

# --- Case 2: runuser masked -> setpriv wins --------------------------------
NO_RUNUSER="$(curated_path setpriv su)"
if PATH="$NO_RUNUSER" command -v runuser >/dev/null 2>&1; then
  fail "runuser is still resolvable under the masked PATH -- the test setup did not actually mask it"
fi
got="$(resolved_helper_under_path "$NO_RUNUSER")"
[[ "$got" == "setpriv" ]] || fail "expected 'setpriv' to be picked with runuser masked out, got '$got'"
echo "PASS: setpriv picked when runuser is absent from PATH"

# --- Case 3: runuser and setpriv masked -> su wins -------------------------
NO_RUNUSER_NO_SETPRIV="$(curated_path su)"
if PATH="$NO_RUNUSER_NO_SETPRIV" command -v runuser >/dev/null 2>&1; then
  fail "runuser is still resolvable under the masked PATH -- the test setup did not actually mask it"
fi
if PATH="$NO_RUNUSER_NO_SETPRIV" command -v setpriv >/dev/null 2>&1; then
  fail "setpriv is still resolvable under the masked PATH -- the test setup did not actually mask it"
fi
got="$(resolved_helper_under_path "$NO_RUNUSER_NO_SETPRIV")"
[[ "$got" == "su" ]] || fail "expected 'su' to be picked with runuser and setpriv both absent from PATH, got '$got'"
echo "PASS: su picked when both runuser and setpriv are absent from PATH"

# --- Case 4: none present -> dies naming all three -------------------------
NONE="$(curated_path)"
set +e
err_output="$(env -u BASH_ENV PATH="$NONE" bash -c "source '$NATIVE_DIR/lib/common.sh' && resolve_drop_privileges_helper" 2>&1)"
rc=$?
set -e
[[ "$rc" -ne 0 ]] || fail "resolve_drop_privileges_helper() should have failed with none of runuser/setpriv/su/python3 on PATH, but exited 0"
for name in runuser setpriv su python3; do
  [[ "$err_output" == *"$name"* ]] || fail "error message did not name '$name' (got: $err_output)"
done
echo "PASS: resolve_drop_privileges_helper() dies naming all four when none is available"

# --- Case 5: setpriv exists but rejects --reuid -> skipped, su wins --------
# This is the real board, exactly: the first live install resolved setpriv on
# an existence check and then died on `setpriv: unrecognized option
# '--reuid'`. Selection must look past a setpriv that cannot take the flags.
BUSYBOX_SETPRIV="$(stubbed_setpriv_path \
  "echo \"setpriv: unrecognized option '\$1'\" >&2; exit 1" su)"
if PATH="$BUSYBOX_SETPRIV" command -v setpriv >/dev/null 2>&1; then
  : # setpriv must still be *present*, or this case proves nothing new
else
  fail "the stubbed setpriv is not resolvable -- this case must test a present-but-incompatible setpriv, not an absent one"
fi
got="$(resolved_helper_under_path "$BUSYBOX_SETPRIV")"
[[ "$got" == "su" ]] || fail "expected 'su' to be picked when setpriv is present but rejects --reuid, got '$got'"
echo "PASS: a present-but-incompatible setpriv is skipped and su is picked"

# --- Case 6: setpriv accepts the flags -> setpriv wins ---------------------
# The guard must not reject every setpriv: one that takes the util-linux
# flags is still the preferred helper over su.
UTIL_LINUX_SETPRIV="$(stubbed_setpriv_path 'exit 0' su)"
got="$(resolved_helper_under_path "$UTIL_LINUX_SETPRIV")"
[[ "$got" == "setpriv" ]] || fail "expected 'setpriv' to be picked when it accepts the util-linux flags, got '$got'"
echo "PASS: a setpriv that accepts the util-linux flags is still preferred over su"

# --- Case 7: setpriv fails on permissions -> still picked -----------------
# The probe runs unprivileged in the gates and on any non-root caller, where
# --init-groups is refused for want of CAP_SETGID. A permission failure says
# nothing about flag support, and the real call runs as root, so setpriv must
# survive it. Without this case the guard would silently demote the helper
# everywhere it is probed without privileges.
EPERM_SETPRIV="$(stubbed_setpriv_path \
  "echo 'setpriv: setgroups: Operation not permitted' >&2; exit 1" su)"
got="$(resolved_helper_under_path "$EPERM_SETPRIV")"
[[ "$got" == "setpriv" ]] || fail "expected 'setpriv' to survive a permission-denied probe, got '$got'"
echo "PASS: setpriv is not demoted when the probe fails for permission reasons"

# stubbed_python3_path <stub-body> <tool...>
# Like stubbed_setpriv_path, but for `python3`: a script with the given body
# stands in for the real interpreter so the availability probe can be forced
# down either path without depending on what python3 build this sandbox has.
stubbed_python3_path() {
  local body="$1"
  shift
  local bindir
  bindir="$(curated_path "$@")"
  printf '#!/usr/bin/env bash\n%s\n' "$body" >"$bindir/python3"
  chmod +x "$bindir/python3"
  printf '%s\n' "$bindir"
}

# --- Case 8: runuser/setpriv/su all masked, python3 present -> python3 wins
WORKING_PYTHON3="$(stubbed_python3_path 'exit 0')"
if PATH="$WORKING_PYTHON3" command -v runuser >/dev/null 2>&1 \
  || PATH="$WORKING_PYTHON3" command -v setpriv >/dev/null 2>&1 \
  || PATH="$WORKING_PYTHON3" command -v su >/dev/null 2>&1; then
  fail "runuser/setpriv/su are still resolvable under the masked PATH -- the test setup did not actually mask them"
fi
got="$(resolved_helper_under_path "$WORKING_PYTHON3")"
[[ "$got" == "python3" ]] || fail "expected 'python3' to be picked when runuser, setpriv and su are all absent, got '$got'"
echo "PASS: python3 picked when runuser, setpriv and su are all absent from PATH"

# --- Case 9: python3 present but missing the stdlib modules -> skipped -----
# A python3 build stripped down enough to lack `os`/`pwd` (or any build that
# cannot import them) must not be picked -- the fallback below would die deep
# inside drop_priv_run() instead of at the readable "no usable helper" point.
BROKEN_PYTHON3="$(stubbed_python3_path "exit 1")"
if PATH="$BROKEN_PYTHON3" command -v python3 >/dev/null 2>&1; then
  : # python3 must still be *present*, or this case proves nothing new
else
  fail "the stubbed python3 is not resolvable -- this case must test a present-but-broken python3, not an absent one"
fi
set +e
err_output="$(env -u BASH_ENV PATH="$BROKEN_PYTHON3" bash -c "source '$NATIVE_DIR/lib/common.sh' && resolve_drop_privileges_helper" 2>&1)"
rc=$?
set -e
[[ "$rc" -ne 0 ]] || fail "resolve_drop_privileges_helper() should have failed with a python3 that cannot import os/pwd, but exited 0"
echo "PASS: a python3 that cannot import os/pwd is not picked"

echo "All drop-priv-helper fallback test cases passed."
