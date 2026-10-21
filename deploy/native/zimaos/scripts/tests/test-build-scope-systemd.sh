#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2015,SC2119,SC2030,SC2031 # single-quoted bodies run in child bash; subshell-local env is intended
# Host test of the real systemd build scope (TOM-686 review findings 2, 3, 8).
# Needs root and a running systemd, so run-gates.sh treats exit 77 as SKIP
# when it runs unprivileged; run it as root on the host to prove the scope
# path (PAPERCLIP_REQUIRE_HOST_TESTS=1 turns a skip into a failure).
#
# Everything it creates is a transient scope named paperclip-build-test-*
# with a 64MB ceiling and a harmless marker process tree. It never touches
# paperclip-native.service or any real paperclip-build-<sha> scope: the
# orphan sweep it tests is called with a glob that matches only its own unit.
#
#   1. auto mode picks systemd on this host (the scope probe works).
#   2. A memory-guard trip stops a three-level tree (the deepest level
#      ignores SIGTERM) inside the real scope, confirms the scope is empty
#      and inactive, and leaves no marker process. While it ran, the scope
#      had the 64MB MemoryMax and its cgroup.procs held the tree.
#   3. systemd-run does not expand ${...} in the build's argv, and the
#      build log names the scope in its [build-scope] memory.peak line.
#   4. SIGKILL of the updater (the process running run_memory_guarded) leaves
#      the scope and its tree running -- the leak -- and
#      stop_orphaned_build_scopes then stops it.
#
# Usage: test-build-scope-systemd.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

if [[ "$(id -u)" -ne 0 ]] || ! systemctl show -p Version --value >/dev/null 2>&1 || ! command -v systemd-run >/dev/null 2>&1; then
  echo "SKIP: needs root and a running systemd with systemd-run (run it as root on the host)." >&2
  [[ "${PAPERCLIP_REQUIRE_HOST_TESTS:-0}" == "1" ]] && exit 1
  exit 77
fi

WORKDIR="$(make_exec_capable_tempdir paperclip-scope-systemd "$NATIVE_DIR")"
MARKER="paperclip-scope-sysd-$$-$RANDOM"
UNIT_BASE="paperclip-build-test-$$"
UPDATER=""

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
  local pid u
  [[ -n "$UPDATER" ]] && kill -KILL "$UPDATER" 2>/dev/null
  for u in "$UNIT_BASE-a" "$UNIT_BASE-b" "$UNIT_BASE-c"; do
    systemctl kill --signal=SIGKILL --kill-whom=all "$u.scope" >/dev/null 2>&1 || true
    systemctl stop "$u.scope" >/dev/null 2>&1 || true
  done
  for pid in $(marker_pids); do kill -KILL "$pid" 2>/dev/null || true; done
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

scope_state() { systemctl show -p ActiveState --value "$1.scope" 2>/dev/null; }

cat >"$WORKDIR/level3.sh" <<'EOF'
#!/usr/bin/env bash
trap '' TERM
touch "$GUARD_TEST_DIR/level3.ready.$GUARD_TEST_TAG"
while :; do sleep 1; done
EOF
cat >"$WORKDIR/level2.sh" <<'EOF'
#!/usr/bin/env bash
bash "$GUARD_TEST_DIR/level3.sh" &
wait
EOF
cat >"$WORKDIR/level1.sh" <<'EOF'
#!/usr/bin/env bash
bash "$GUARD_TEST_DIR/level2.sh" &
wait
EOF
chmod +x "$WORKDIR"/level*.sh

export BUILD_SCOPE_MODE=systemd BUILD_MEMORY_MAX_MB=64 BUILD_SWAP_MAX_MB=0 BUILD_KILL_GRACE_SECONDS=2
export BUILD_ALLOW_SETSID_FOR_TESTS=0

# --- 1. auto mode picks systemd ---------------------------------------------------
mode="$(BUILD_SCOPE_MODE=auto DRY_RUN=0 BUILD_GUARD_MODE="" build_scope_mode)" \
  || fail "1: build_scope_mode failed on this host"
[[ "$mode" == "systemd" ]] || fail "1: auto mode picked '$mode', expected systemd"
echo "PASS: auto mode picks a systemd scope on this host (the scope probe works)"

# --- 2. A tripped guard stops the tree inside the real scope ----------------------
export GUARD_TEST_DIR="$WORKDIR"
TAG=a
mem_available_mb() {
  if [[ -e "$WORKDIR/level3.ready.$TAG" ]]; then
    if [[ ! -e "$WORKDIR/evidence.$TAG" ]]; then
      {
        echo "cg=$(systemctl show -p ControlGroup --value "$UNIT_BASE-$TAG.scope")"
        echo "memmax=$(systemctl show -p MemoryMax --value "$UNIT_BASE-$TAG.scope")"
        echo "procs=$(tr '\n' ' ' <"/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$UNIT_BASE-$TAG.scope")/cgroup.procs")"
      } >"$WORKDIR/evidence.$TAG" 2>&1
    fi
    echo 1
  else
    echo 999999
  fi
}
set +e
(
  export BUILD_SCOPE_UNIT="$UNIT_BASE-a"
  run_memory_guarded "fake build" 100 1 -- \
    env PAPERCLIP_SCOPE_TEST_MARKER="$MARKER" GUARD_TEST_DIR="$WORKDIR" GUARD_TEST_TAG=a bash "$WORKDIR/level1.sh"
) >"$WORKDIR/guard-a.out" 2>&1 </dev/null
rc=$?
set -e
output="$(cat "$WORKDIR/guard-a.out")"
[[ -e "$WORKDIR/level3.ready.a" ]] || fail "2: the tree never came up. $output"
[[ "$rc" -ne 0 ]] || fail "2: run_memory_guarded returned 0 after its guard tripped. $output"
printf '%s\n' "$output" | grep -q "BUILD_EXIT=91-class" || fail "2: no BUILD_EXIT=91-class error. $output"
printf '%s\n' "$output" | grep -q "Confirmed: no build process left" || fail "2: the guard did not confirm the scope is empty. $output"
[[ -z "$(marker_pids)" ]] || fail "2: marker processes survived: $(marker_pids | tr '\n' ' '). $output"
[[ "$(scope_state "$UNIT_BASE-a")" != "active" ]] || fail "2: the scope is still active. $output"
evidence="$(cat "$WORKDIR/evidence.a")"
printf '%s\n' "$evidence" | grep -q "^cg=.*/$UNIT_BASE-a.scope$" || fail "2: the scope had no ControlGroup of its own while it ran: $evidence"
printf '%s\n' "$evidence" | grep -q "^memmax=$((64 * 1048576))$" || fail "2: the scope did not have MemoryMax=64M while it ran: $evidence"
printf '%s\n' "$evidence" | grep -Eq "^procs=[0-9]+" || fail "2: the scope's cgroup.procs was empty while the tree ran: $evidence"
echo "PASS: a memory-guard trip stopped the three-level tree inside a real scope (MemoryMax 64M, SIGTERM-ignoring level included) and confirmed the scope empty"

# --- 3. No ${...} expansion in the argv; the scope is named in the log ------------
mem_available_mb() { echo 999999; }
set +e
(
  export BUILD_SCOPE_UNIT="$UNIT_BASE-c"
  run_memory_guarded "arg test" 100 1 -- bash -c 'printf "ARG=%s\n" "$1"' x '${cg##*/}$HOME'
) >"$WORKDIR/guard-c.out" 2>&1 </dev/null
rc=$?
set -e
[[ "$rc" -eq 0 ]] || fail "3: the arg-test build failed (rc=$rc): $(cat "$WORKDIR/guard-c.out")"
grep -qF 'ARG=${cg##*/}$HOME' "$WORKDIR/guard-c.out" || fail "3: systemd-run rewrote a dollar-brace expression in the build's argument: $(cat "$WORKDIR/guard-c.out")"
grep -q "Invalid environment variable name" "$WORKDIR/guard-c.out" && fail "3: systemd-run still warns about an invalid environment variable name: $(cat "$WORKDIR/guard-c.out")"
grep -q "\[build-scope\] $UNIT_BASE-c.scope memory.peak=" "$WORKDIR/guard-c.out" || fail "3: the [build-scope] line does not name the scope: $(cat "$WORKDIR/guard-c.out")"
echo "PASS: the build's argument reaches it unchanged, no environment-variable warning, and [build-scope] names the scope"

# --- 4. SIGKILL of the updater leaves the scope; the orphan sweep stops it --------
TAG=b
set +e
(
  export BUILD_SCOPE_UNIT="$UNIT_BASE-b"
  mem_available_mb() { echo 999999; }
  run_memory_guarded "fake build" 100 1 -- \
    env PAPERCLIP_SCOPE_TEST_MARKER="$MARKER" GUARD_TEST_DIR="$WORKDIR" GUARD_TEST_TAG=b bash "$WORKDIR/level1.sh"
) >"$WORKDIR/guard-b.out" 2>&1 </dev/null &
UPDATER=$!
set -e
for _ in $(seq 1 100); do
  [[ -e "$WORKDIR/level3.ready.b" ]] && break
  sleep 0.1
done
[[ -e "$WORKDIR/level3.ready.b" ]] || fail "3: the tree never came up. $(cat "$WORKDIR/guard-b.out")"
kill -KILL "$UPDATER"
wait "$UPDATER" 2>/dev/null || true
UPDATER=""
sleep 1
[[ -n "$(marker_pids)" && "$(scope_state "$UNIT_BASE-b")" == "active" ]] \
  || fail "3: expected the scope and its tree to outlive the SIGKILLed updater (the leak this test guards against); scope=$(scope_state "$UNIT_BASE-b") markers=$(marker_pids | tr '\n' ' ')"
echo "PASS: confirmed the leak: SIGKILL of the updater leaves the scope and its tree running"
stop_orphaned_build_scopes "$UNIT_BASE-b.scope" >"$WORKDIR/sweep.out" 2>&1 || fail "3: the orphan sweep failed: $(cat "$WORKDIR/sweep.out")"
[[ -z "$(marker_pids)" ]] || fail "3: marker processes survived the orphan sweep: $(marker_pids | tr '\n' ' ')"
[[ "$(scope_state "$UNIT_BASE-b")" != "active" ]] || fail "3: the scope is still active after the orphan sweep"
echo "PASS: stop_orphaned_build_scopes stopped the orphaned scope and every process in it"
