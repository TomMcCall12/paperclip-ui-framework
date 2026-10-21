#!/usr/bin/env bash
# Offline test for run_memory_guarded() (TOM-686): a tripped guard must
# leave no process of the build behind.
#
# On 21 Oct the guard tripped, logged the build as cancelled and exited,
# but its `kill` reached only the bash subshell it had backgrounded; pnpm,
# node and tsc below it kept running for 41 more minutes on a host that was
# already live-locked. This test builds the same shape without root: a
# three-level process tree (bash -> bash -> a loop that ignores SIGTERM, so
# only SIGKILL can stop it), every level tagged with a unique marker in its
# environment. It trips the guard once the whole tree is up, then scans
# /proc for any process that still carries the marker.
#
# Runs the setsid fallback (no root, no systemd needed). The systemd-scope
# path shares the same stop/confirm code and is proven on the host (S3).
#
# Usage: test-memory-guard-kills-tree.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(make_exec_capable_tempdir paperclip-guard-test "$NATIVE_DIR")"
MARKER="paperclip-guard-test-$$-$RANDOM"

marker_pids() {
  local f
  for f in /proc/[0-9]*/environ; do
    if { tr '\0' '\n' <"$f"; } 2>/dev/null | grep -qx "PAPERCLIP_GUARD_TEST_MARKER=$MARKER"; then
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

# Level 3 ignores SIGTERM (an ignored signal stays ignored across exec, so
# its `sleep` children ignore it too): only the SIGKILL escalation stops it.
cat >"$WORKDIR/level3.sh" <<'EOF'
#!/usr/bin/env bash
trap '' TERM
touch "$GUARD_TEST_DIR/level3.ready"
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

# The guard polls MemAvailable through mem_available_mb(); report plenty of
# memory until the whole tree is up, then report almost none, so the trip
# always happens with three live levels to stop.
mem_available_mb() {
  if [[ -e "$WORKDIR/level3.ready" ]]; then echo 1; else echo 999999; fi
}

export BUILD_SCOPE_MODE=setsid
export BUILD_KILL_GRACE_SECONDS=2
# Output goes to a file, not a $(...) capture: a leaked build process would
# hold a capture pipe open and hang this test instead of failing it.
set +e
(
  run_memory_guarded "fake build" 100 1 -- \
    env PAPERCLIP_GUARD_TEST_MARKER="$MARKER" GUARD_TEST_DIR="$WORKDIR" bash "$WORKDIR/level1.sh"
) >"$WORKDIR/guard.out" 2>&1 </dev/null
rc=$?
set -e
output="$(cat "$WORKDIR/guard.out")"

[[ -e "$WORKDIR/level3.ready" ]] || fail "the fake build tree never reached level 3. Output:
$output"
[[ "$rc" -ne 0 ]] || fail "run_memory_guarded returned 0 after its guard tripped. Output:
$output"
printf '%s\n' "$output" | grep -q "BUILD_EXIT=91-class" \
  || fail "expected a BUILD_EXIT=91-class error after the trip. Output:
$output"

# The guard must have confirmed the tree is gone before it died, so this
# check needs no grace period: anything still alive now is a leak.
survivors="$(marker_pids)"
if [[ -n "$survivors" ]]; then
  details="$(for pid in $survivors; do printf '  %s %s\n' "$pid" "$({ tr '\0' ' ' </proc/"$pid"/cmdline; } 2>/dev/null)"; done)"
  fail "the guard tripped but these build processes are still running:
$details
Guard output:
$output"
fi
printf '%s\n' "$output" | grep -q "Confirmed: no build process left" \
  || fail "the guard did not log that it confirmed the build is gone. Output:
$output"

echo "PASS: a tripped memory guard stopped all three levels of the build (SIGTERM-ignoring level included) and confirmed none is left."

# Untripped runs: the build's own exit code comes back unchanged, and a
# process the build leaves behind in its group is stopped, not leaked.
mem_available_mb() { echo 999999; }
set +e
( run_memory_guarded "exits 3" 100 1 -- bash -c 'exit 3' ) >"$WORKDIR/rc.out" 2>&1 </dev/null
rc=$?
set -e
[[ "$rc" -eq 3 ]] || fail "expected the build's exit code 3 back from run_memory_guarded, got $rc. Output:
$(cat "$WORKDIR/rc.out")"
( run_memory_guarded "leaves a straggler" 100 1 -- \
    env PAPERCLIP_GUARD_TEST_MARKER="$MARKER" bash -c 'sleep 300 & exit 0' ) >"$WORKDIR/straggler.out" 2>&1 </dev/null \
  || fail "a build that exited 0 was reported as failed. Output:
$(cat "$WORKDIR/straggler.out")"
[[ -z "$(marker_pids)" ]] || fail "a background process left behind by a finished build is still running. Output:
$(cat "$WORKDIR/straggler.out")"
echo "PASS: an untripped build returns its own exit code, and processes it leaves behind are stopped."
