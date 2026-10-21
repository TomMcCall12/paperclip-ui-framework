#!/usr/bin/env bash
# Offline test for paperclip-update.sh's exit safety net (TOM-686):
# update_exit_safety_net in deploy/native/lib/common.sh, armed by
# arm_update_exit_trap. After an aborted or failed update, at any stage, it
# must restart paperclip-native.service only when /api/health fails, and
# never restart a healthy server.
#
# `systemctl` and `curl` are stubs on PATH: curl answers from a state file
# ("up"/"down"), and a stubbed `systemctl restart` records the call and
# flips the state to "up", the way a real restart brings the server back.
#
# Usage: test-update-exit-trap.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIMAOS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
NATIVE_DIR="$(cd "$ZIMAOS_DIR/.." && pwd)"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(make_exec_capable_tempdir paperclip-exit-trap-test "$NATIVE_DIR")"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mkdir -p "$WORKDIR/bin"
cat >"$WORKDIR/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >>"$STUB_DIR/calls.log"
[[ "$(cat "$STUB_DIR/health")" == "up" ]]
EOF
cat >"$WORKDIR/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >>"$STUB_DIR/calls.log"
if [[ "${1:-}" == "restart" ]]; then echo up >"$STUB_DIR/health"; fi
exit 0
EOF
chmod +x "$WORKDIR/bin/curl" "$WORKDIR/bin/systemctl"

# run_case <name> <initial-health> <phase> <how-it-ends>
# Runs a child bash that sources common.sh, arms the trap the way
# paperclip-update.sh does, sets UPDATE_PHASE and then ends as told:
# "exit N" or "sigterm". Sets CASE_RC and CASE_OUT.
# shellcheck disable=SC2016 # the inner bash expands these, not this one
run_case() {
  local name="$1" health="$2" phase="$3" how="$4" case_dir="$WORKDIR/$1"
  mkdir -p "$case_dir/releases/old" "$case_dir/releases/new"
  ln -sfn "$case_dir/releases/new" "$case_dir/current"
  echo "$health" >"$case_dir/health"
  : >"$case_dir/calls.log"
  set +e
  # env -u BASH_ENV, and PATH set inside the child: a BASH_ENV startup file
  # can reset PATH, which would reach the real systemctl and curl. The
  # child refuses to go on unless both resolve to the stubs.
  STUB_DIR="$case_dir" env -u BASH_ENV bash -c '
    PATH="$5:$PATH"
    [[ "$(command -v systemctl)" == "$5/systemctl" && "$(command -v curl)" == "$5/curl" ]] \
      || { echo "stubs not on PATH; refusing to run" >&2; exit 99; }
    source "$1"
    DRY_RUN=0
    UPDATE_HEALTH_URL="http://127.0.0.1:3101/api/health"
    UPDATE_CURRENT_LINK="$2/current"
    UPDATE_PREV_RELEASE="$2/releases/old"
    UPDATE_HEALTH_ATTEMPTS=3
    UPDATE_HEALTH_DELAY=0
    arm_update_exit_trap
    UPDATE_PHASE="$3"
    case "$4" in
      sigterm) kill -TERM $$; sleep 5; exit 0 ;;
      exit*) exit "${4#exit }" ;;
    esac
  ' test-update "$NATIVE_DIR/lib/common.sh" "$case_dir" "$phase" "$how" "$WORKDIR/bin" >"$case_dir/out" 2>&1
  CASE_RC=$?
  set -e
  CASE_OUT="$(cat "$case_dir/out")
calls:
$(cat "$case_dir/calls.log")"
  CASE_DIR="$case_dir"
  [[ "$CASE_RC" -ne 99 ]] || fail "$name: the systemctl/curl stubs were not on PATH. $CASE_OUT"
}

restarts() { grep -c '^systemctl restart paperclip-native.service$' "$CASE_DIR/calls.log" || true; }

# 1. Build failed, server healthy: probe, no restart, exit code kept.
run_case healthy-build-failure up build "exit 1"
[[ "$CASE_RC" -eq 1 ]] || fail "healthy-build-failure: expected exit code 1 preserved, got $CASE_RC. $CASE_OUT"
grep -q '^curl ' "$CASE_DIR/calls.log" || fail "healthy-build-failure: the trap never probed /api/health. $CASE_OUT"
[[ "$(restarts)" -eq 0 ]] || fail "healthy-build-failure: the trap restarted a healthy server. $CASE_OUT"
echo "PASS: failed update + healthy server -> health probed, no restart, exit code 1 kept"

# 2. Build failed, server down: exactly one restart, then health is awaited.
run_case down-build-failure down build "exit 1"
[[ "$CASE_RC" -eq 1 ]] || fail "down-build-failure: expected exit code 1, got $CASE_RC. $CASE_OUT"
[[ "$(restarts)" -eq 1 ]] || fail "down-build-failure: expected exactly one restart of a down server. $CASE_OUT"
grep -q "healthy again after the safety-net restart" "$CASE_DIR/out" \
  || fail "down-build-failure: the trap did not wait for health after the restart. $CASE_OUT"
echo "PASS: failed update + server down -> one restart, then waited for health"

# 3. SIGTERM mid-build, server down: same trap runs, exit 143, one restart.
run_case down-sigterm down build sigterm
[[ "$CASE_RC" -eq 143 ]] || fail "down-sigterm: expected exit code 143 after SIGTERM, got $CASE_RC. $CASE_OUT"
[[ "$(restarts)" -eq 1 ]] || fail "down-sigterm: expected one restart after SIGTERM with the server down. $CASE_OUT"
echo "PASS: SIGTERM + server down -> trap ran, one restart, exit 143"

# 4. SIGTERM, server healthy: no restart.
run_case healthy-sigterm up build sigterm
[[ "$CASE_RC" -eq 143 ]] || fail "healthy-sigterm: expected exit code 143, got $CASE_RC. $CASE_OUT"
[[ "$(restarts)" -eq 0 ]] || fail "healthy-sigterm: the trap restarted a healthy server. $CASE_OUT"
echo "PASS: SIGTERM + healthy server -> no restart"

# 5. Aborted after `current` was switched but before any restart, server
#    healthy: current goes back to the previous release, no restart.
run_case healthy-switched up switched "exit 1"
[[ "$(readlink "$CASE_DIR/current")" == "$CASE_DIR/releases/old" ]] \
  || fail "healthy-switched: current was not pointed back at the previous release. $CASE_OUT"
[[ "$(restarts)" -eq 0 ]] || fail "healthy-switched: the trap restarted a healthy server. $CASE_OUT"
echo "PASS: aborted after switching current + healthy server -> current reverted, no restart"

# 6. Restarted onto the new release and it is down: revert, then restart.
run_case down-restarted down restarted "exit 1"
[[ "$(readlink "$CASE_DIR/current")" == "$CASE_DIR/releases/old" ]] \
  || fail "down-restarted: current was not pointed back before the restart. $CASE_OUT"
[[ "$(restarts)" -eq 1 ]] || fail "down-restarted: expected one restart. $CASE_OUT"
echo "PASS: down after restarting onto the new release -> current reverted, one restart"

# 7. A verified, successful update never probes or restarts anything.
run_case success down "done" "exit 0"
[[ "$CASE_RC" -eq 0 ]] || fail "success: expected exit code 0, got $CASE_RC. $CASE_OUT"
[[ "$(restarts)" -eq 0 ]] || fail "success: the trap restarted after a successful update. $CASE_OUT"
echo "PASS: successful update -> trap does nothing"

# 8. paperclip-update.sh really arms this trap, and its --dry-run says so.
grep -q '^arm_update_exit_trap$' "$ZIMAOS_DIR/paperclip-update.sh" \
  || fail "paperclip-update.sh does not call arm_update_exit_trap"
dry="$("$ZIMAOS_DIR/paperclip-update.sh" --commit 0000000 --repo-src "$NATIVE_DIR" --root "$WORKDIR/root" --dry-run 2>&1)" \
  || fail "paperclip-update.sh --dry-run failed: $dry"
printf '%s\n' "$dry" | grep -q "exit trap armed" || fail "paperclip-update.sh --dry-run does not show the exit trap. Output:
$dry"
echo "PASS: paperclip-update.sh arms the exit trap and its --dry-run shows it"
