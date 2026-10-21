#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2015,SC2119,SC2030,SC2031 # single-quoted bodies run in child bash; subshell-local env is intended
# Offline test, no root and no systemd, for how run_memory_guarded() and
# stop_orphaned_build_scopes() treat the systemd build scope (TOM-686 review
# findings 2, 4 and 5). `systemctl` and `systemd-run` are stubs that keep the
# scope's state in files and its cgroup.procs under a fake cgroup tree.
#
#   1. A normal build leaves the scope gone, and the guard asks systemd for
#      the scope's own ControlGroup.
#   2. Fail closed: a scope that is active but reports no ControlGroup, or
#      whose cgroup.procs cannot be read, makes the build fail.
#   3. A scope that still holds a process after SIGKILL and stop makes the
#      build fail even when the build itself exited 0 (no `|| true`).
#   4. A scope that does stop is cleaned up: its processes are gone, rc 0.
#   5. No hard ceiling means no build: auto mode dies when the scope probe
#      fails or the host cannot make a scope; setsid is refused unless the
#      test-only switch is set. The build command never runs in these cases.
#   6. stop_orphaned_build_scopes stops build scopes (not other scopes), and
#      fails when one cannot be stopped.
#
# The real-systemd counterpart is test-build-scope-systemd.sh (needs root).
#
# Usage: test-build-scope-fail-closed.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(make_exec_capable_tempdir paperclip-scope-failclosed "$NATIVE_DIR")"
export STUB_DIR="$WORKDIR/stub" CGROOT="$WORKDIR/cgroup"
BIN="$WORKDIR/bin"
mkdir -p "$STUB_DIR" "$CGROOT" "$BIN"
MARKER="paperclip-scope-test-$$-$RANDOM"

marker_pids() {
  local f
  for f in /proc/[0-9]*/environ; do
    if { tr '\0' '\n' <"$f"; } 2>/dev/null | grep -qx "PAPERCLIP_SCOPE_TEST_MARKER=$MARKER"; then
      basename "$(dirname "$f")"
    fi
  done
  return 0
}

cleanup() {
  local pid
  for pid in $(marker_pids); do kill -KILL "$pid" 2>/dev/null || true; done
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# systemctl: scope state lives in $STUB_DIR/state.<unit> and cg.<unit>; the
# processes of a scope are the pids listed in its cgroup.procs. kill/stop
# empty the scope (and really kill those pids) unless stop-ineffective exists.
cat >"$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >>"$STUB_DIR/calls.log"
unit="${*: -1}"
cgfile() { cat "$STUB_DIR/cg.$unit" 2>/dev/null || true; }
case "$1" in
  show)
    [[ -e "$STUB_DIR/show-fails" ]] && exit 1
    case "$3" in
      ActiveState) cat "$STUB_DIR/state.$unit" 2>/dev/null || echo inactive ;;
      ControlGroup) if [[ -e "$STUB_DIR/cg-hidden" ]]; then echo; else cgfile; fi ;;
    esac
    ;;
  kill|stop)
    [[ -e "$STUB_DIR/stop-ineffective" ]] && exit 0
    cg="$(cgfile)"
    if [[ -n "$cg" && -f "$CGROOT$cg/cgroup.procs" ]]; then
      for pid in $(cat "$CGROOT$cg/cgroup.procs"); do kill -KILL "$pid" 2>/dev/null || true; done
      : >"$CGROOT$cg/cgroup.procs"
    fi
    if [[ "$1" == "stop" ]]; then rm -f "$STUB_DIR/state.$unit" "$STUB_DIR/cg.$unit"; fi
    ;;
  list-units) cat "$STUB_DIR/units" 2>/dev/null || true ;;
esac
exit 0
EOF
# systemd-run --scope ... --unit=<u> ... -- <cmd...>: registers the scope as
# active with a cgroup holding the command's pid, runs the command, and (like
# systemd) removes the scope when it exits unless leave-populated exists.
cat >"$BIN/systemd-run" <<'EOF'
#!/usr/bin/env bash
echo "systemd-run $*" >>"$STUB_DIR/calls.log"
unit=""
while [[ "$1" != "--" ]]; do
  case "$1" in --unit=*) unit="${1#--unit=}" ;; esac
  shift
done
shift
[[ "$unit" == *probe* && -e "$STUB_DIR/probe-fails" ]] && exit 1
[[ -e "$STUB_DIR/run-fails" ]] && exit 1
cg="/fake.slice/$unit.scope"
mkdir -p "$CGROOT$cg"
echo active >"$STUB_DIR/state.$unit.scope"
echo "$cg" >"$STUB_DIR/cg.$unit.scope"
if [[ -e "$STUB_DIR/procs-unreadable" ]]; then
  rm -rf "$CGROOT$cg/cgroup.procs"; mkdir "$CGROOT$cg/cgroup.procs"
else
  : >"$CGROOT$cg/cgroup.procs"
fi
"$@" &
child=$!
[[ -e "$STUB_DIR/procs-unreadable" ]] || echo "$child" >"$CGROOT$cg/cgroup.procs"
rc=0
wait "$child" || rc=$?
if [[ ! -e "$STUB_DIR/leave-populated" ]]; then
  : >"$CGROOT$cg/cgroup.procs" 2>/dev/null || true
  rm -f "$STUB_DIR/state.$unit.scope" "$STUB_DIR/cg.$unit.scope"
fi
exit "$rc"
EOF
chmod +x "$BIN/systemctl" "$BIN/systemd-run"
export PATH="$BIN:$PATH"
[[ "$(command -v systemctl)" == "$BIN/systemctl" ]] || fail "the systemctl stub is not first on PATH; refusing to run"

export BUILD_SCOPE_MODE=systemd BUILD_CGROUP_ROOT="$CGROOT" BUILD_KILL_GRACE_SECONDS=0 BUILD_KILL_WAIT_SECONDS=1
mem_available_mb() { echo 999999; }
reset_stubs() {
  rm -rf "$STUB_DIR" "$CGROOT"
  mkdir -p "$STUB_DIR" "$CGROOT"
  : >"$STUB_DIR/calls.log"
  BUILD_GUARD_MODE=""
  BUILD_GUARD_LEADER=""
  BUILD_GUARD_CGROUP=""
}
# guarded <unit> <command...>: runs run_memory_guarded in a subshell (die
# exits it); sets GUARD_RC and GUARD_OUT.
guarded() {
  local unit="$1"
  shift
  # Output goes to a file, not a $(...) capture: a leaked build process would
  # hold a capture pipe open and hang this test instead of failing it.
  set +e
  (
    export BUILD_SCOPE_UNIT="$unit"
    run_memory_guarded "fake build" 100 1 -- "$@"
  ) >"$WORKDIR/guard.out" 2>&1 </dev/null
  GUARD_RC=$?
  set -e
  GUARD_OUT="$(cat "$WORKDIR/guard.out")"
}

# --- 1. A normal build ------------------------------------------------------------
reset_stubs
guarded paperclip-build-t1 bash -c 'touch "$STUB_DIR/build-ran"; exit 0'
[[ "$GUARD_RC" -eq 0 && -e "$STUB_DIR/build-ran" ]] || fail "1: a clean build failed (rc=$GUARD_RC): $GUARD_OUT"
grep -q -- '--unit=paperclip-build-t1 ' "$STUB_DIR/calls.log" && grep -q 'MemoryMax=' "$STUB_DIR/calls.log" || fail "1: the build did not run through systemd-run with a MemoryMax. $(cat "$STUB_DIR/calls.log")"
grep -q '^systemctl show -p ControlGroup --value paperclip-build-t1.scope$' "$STUB_DIR/calls.log" || fail "1: the guard did not ask systemd for the scope's ControlGroup. $(cat "$STUB_DIR/calls.log")"
grep -q -- '--expand-environment=no' "$STUB_DIR/calls.log" || fail "1: systemd-run was not given --expand-environment=no. $(cat "$STUB_DIR/calls.log")"
echo "PASS: a clean build runs in a systemd scope (MemoryMax, no argv expansion) and the guard asks systemd for the scope's cgroup"

# --- 2. Fail closed ---------------------------------------------------------------
reset_stubs
touch "$STUB_DIR/leave-populated" "$STUB_DIR/cg-hidden" "$STUB_DIR/stop-ineffective"
guarded paperclip-build-t2a bash -c 'touch "$STUB_DIR/build-ran"; exit 0'
[[ "$GUARD_RC" -ne 0 ]] || fail "2a: the build passed although the scope is active and reports no ControlGroup: $GUARD_OUT"
printf '%s\n' "$GUARD_OUT" | grep -q "no ControlGroup" || fail "2a: wrong error: $GUARD_OUT"
echo "PASS: an active scope with no ControlGroup fails the build (cannot verify it is empty)"

reset_stubs
touch "$STUB_DIR/procs-unreadable" "$STUB_DIR/leave-populated" "$STUB_DIR/stop-ineffective"
guarded paperclip-build-t2b bash -c 'exit 0'
[[ "$GUARD_RC" -ne 0 ]] || fail "2b: the build passed although cgroup.procs cannot be read: $GUARD_OUT"
printf '%s\n' "$GUARD_OUT" | grep -q "cannot read" || fail "2b: wrong error: $GUARD_OUT"
echo "PASS: an unreadable cgroup.procs fails the build"

reset_stubs
touch "$STUB_DIR/show-fails" "$STUB_DIR/leave-populated" "$STUB_DIR/stop-ineffective"
guarded paperclip-build-t2c bash -c 'exit 0'
[[ "$GUARD_RC" -ne 0 ]] || fail "2c: the build passed although systemd cannot be queried: $GUARD_OUT"
echo "PASS: a scope systemd cannot be asked about fails the build"

# --- 3. Cleanup failure is not ignored --------------------------------------------
reset_stubs
touch "$STUB_DIR/leave-populated" "$STUB_DIR/stop-ineffective"
# The build exits 0 but a marker process stays in the (still active) scope.
cat >"$WORKDIR/straggler.sh" <<'EOF'
#!/usr/bin/env bash
sleep 300 &
mkdir -p "$CGROOT/fake.slice/paperclip-build-t3.scope"
echo $! >>"$CGROOT/fake.slice/paperclip-build-t3.scope/cgroup.procs"
exit 0
EOF
chmod +x "$WORKDIR/straggler.sh"
guarded paperclip-build-t3 env PAPERCLIP_SCOPE_TEST_MARKER="$MARKER" bash "$WORKDIR/straggler.sh"
[[ "$GUARD_RC" -ne 0 ]] || fail "3: the build exited 0 but left a process in a scope that would not stop, and run_memory_guarded still returned 0: $GUARD_OUT"
printf '%s\n' "$GUARD_OUT" | grep -q "could not confirm that every build process is gone" || fail "3: wrong error: $GUARD_OUT"
for pid in $(marker_pids); do kill -KILL "$pid" 2>/dev/null || true; done
echo "PASS: a build whose scope cannot be emptied fails even though the build exited 0"

# --- 4. A scope that does stop is cleaned up --------------------------------------
reset_stubs
touch "$STUB_DIR/leave-populated"
guarded paperclip-build-t3 env PAPERCLIP_SCOPE_TEST_MARKER="$MARKER" bash "$WORKDIR/straggler.sh"
[[ "$GUARD_RC" -eq 0 ]] || fail "4: a straggler in a scope that stops cleanly failed the build (rc=$GUARD_RC): $GUARD_OUT"
[[ -z "$(marker_pids)" ]] || fail "4: the straggler was not killed: $GUARD_OUT"
echo "PASS: a straggler left in the scope is killed and the build then passes"

# --- 5. No ceiling, no build ------------------------------------------------------
reset_stubs
export BUILD_SCOPE_MODE=auto
build_scope_host_ok() { return 0; }
touch "$STUB_DIR/probe-fails"
guarded paperclip-build-t5a bash -c 'touch "$STUB_DIR/build-ran"'
[[ "$GUARD_RC" -ne 0 && ! -e "$STUB_DIR/build-ran" ]] || fail "5a: the build ran (or passed) although the scope probe failed (rc=$GUARD_RC): $GUARD_OUT"
printf '%s\n' "$GUARD_OUT" | grep -q "no hard memory ceiling" || fail "5a: wrong error: $GUARD_OUT"
echo "PASS: auto mode refuses to build when the scope probe fails (no setsid fallback)"

reset_stubs
build_scope_host_ok() { return 1; }
guarded paperclip-build-t5b bash -c 'touch "$STUB_DIR/build-ran"'
[[ "$GUARD_RC" -ne 0 && ! -e "$STUB_DIR/build-ran" ]] || fail "5b: the build ran on a host that cannot make a scope (rc=$GUARD_RC): $GUARD_OUT"
echo "PASS: auto mode refuses to build on a host that cannot make a scope"

reset_stubs
export BUILD_SCOPE_MODE=setsid
guarded paperclip-build-t5c bash -c 'touch "$STUB_DIR/build-ran"'
[[ "$GUARD_RC" -ne 0 && ! -e "$STUB_DIR/build-ran" ]] || fail "5c: setsid mode built without the test-only switch (rc=$GUARD_RC): $GUARD_OUT"
printf '%s\n' "$GUARD_OUT" | grep -q "test-only" || fail "5c: wrong error: $GUARD_OUT"
BUILD_ALLOW_SETSID_FOR_TESTS=1 guarded paperclip-build-t5c bash -c 'touch "$STUB_DIR/build-ran"'
[[ "$GUARD_RC" -eq 0 && -e "$STUB_DIR/build-ran" ]] || fail "5c: setsid mode with the test switch did not build (rc=$GUARD_RC): $GUARD_OUT"
echo "PASS: setsid (no ceiling) builds only behind the test-only switch"
export BUILD_SCOPE_MODE=systemd

# --- 6. Orphaned scopes -----------------------------------------------------------
reset_stubs
printf '%s\n' 'paperclip-build-0123456789ab.scope loaded active running Transient scope' \
  '● paperclip-build-probe-77.scope loaded failed failed Transient scope' \
  'something-else.scope loaded active running Other' >"$STUB_DIR/units"
for u in paperclip-build-0123456789ab.scope paperclip-build-probe-77.scope something-else.scope; do
  echo active >"$STUB_DIR/state.$u"
  echo "/fake.slice/$u" >"$STUB_DIR/cg.$u"
  mkdir -p "$CGROOT/fake.slice/$u"
  env PAPERCLIP_SCOPE_TEST_MARKER="$MARKER" sleep 300 &
  echo $! >"$CGROOT/fake.slice/$u/cgroup.procs"
  disown
done
DRY_RUN=0 stop_orphaned_build_scopes >"$WORKDIR/orphans.out" 2>&1 || fail "6: stop_orphaned_build_scopes failed: $(cat "$WORKDIR/orphans.out")"
grep -q '^systemctl stop paperclip-build-0123456789ab.scope$' "$STUB_DIR/calls.log" || fail "6: the orphan build scope was not stopped"
grep -q '^systemctl stop paperclip-build-probe-77.scope$' "$STUB_DIR/calls.log" || fail "6: the orphan probe scope was not stopped"
grep -q 'systemctl stop something-else' "$STUB_DIR/calls.log" && fail "6: stopped a scope that is not a build scope"
[[ "$(marker_pids | wc -l)" -eq 1 ]] || fail "6: expected exactly the unrelated scope's process to survive, found: $(marker_pids | tr '\n' ' ')"
echo "PASS: stop_orphaned_build_scopes stops leftover build scopes, kills their processes, and leaves other scopes alone"

reset_stubs
printf '%s\n' 'paperclip-build-0123456789ab.scope loaded active running Transient scope' >"$STUB_DIR/units"
u=paperclip-build-0123456789ab.scope
echo active >"$STUB_DIR/state.$u"
echo "/fake.slice/$u" >"$STUB_DIR/cg.$u"
mkdir -p "$CGROOT/fake.slice/$u"
env PAPERCLIP_SCOPE_TEST_MARKER="$MARKER" sleep 300 &
echo $! >"$CGROOT/fake.slice/$u/cgroup.procs"
disown
touch "$STUB_DIR/stop-ineffective"
BUILD_KILL_GRACE_SECONDS=0 DRY_RUN=0 stop_orphaned_build_scopes >"$WORKDIR/orphans.out" 2>&1 \
  && fail "6b: stop_orphaned_build_scopes reported success although the scope would not stop"
echo "PASS: stop_orphaned_build_scopes fails when a leftover scope cannot be stopped"
