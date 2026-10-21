#!/usr/bin/env bash
# Offline test for the TOM-686 host safety net, no root needed:
#   A. paperclip-recover.sh: stands back while paperclip-update.sh holds its
#      lock; leaves a server that answers the second probe alone; restarts a
#      server that fails it; restarts at most once per 15 minutes.
#   B. paperclip-oom-guard.sh (one pass, fake /proc and cgroup trees): the
#      server main process and embedded Postgres get -500; a process that
#      inherited -500 at fork is raised to 0; nothing is lowered.
#   C. install_safety_net: renders the units for the given root, installs
#      only what changed, and runs daemon-reload only when a unit changed.
# `systemctl` and `curl` are stubs; each child refuses to run unless they
# resolve to the stubs (a BASH_ENV startup file can reset PATH).
#
# Usage: test-host-safety-net.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIMAOS_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
NATIVE_DIR="$(cd "$ZIMAOS_DIR/.." && pwd)"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(make_exec_capable_tempdir paperclip-safety-net-test "$NATIVE_DIR")"
LOCK_HOLDER=""
cleanup() {
  [[ -n "${GUARD_PID:-}" ]] && { kill "$GUARD_PID" 2>/dev/null || true; }
  [[ -n "$LOCK_HOLDER" ]] && kill "$LOCK_HOLDER" 2>/dev/null
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

BIN="$WORKDIR/bin"
mkdir -p "$BIN"
cat >"$BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >>"$STUB_DIR/calls.log"
# Optional hook: runs once, on the first probe after it is armed (used to
# take the update lock in the window before the recovery unit locks it).
if [[ -x "$STUB_DIR/on-first-probe" ]]; then
  mv "$STUB_DIR/on-first-probe" "$STUB_DIR/on-first-probe.done"
  "$STUB_DIR/on-first-probe.done"
fi
[[ "$(cat "$STUB_DIR/health")" == "up" ]]
EOF
cat >"$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >>"$STUB_DIR/calls.log"
case "$*" in
  "restart paperclip-native.service")
    # Can an updater get the update lock while the restart is in progress?
    if flock -n "$STUB_LOCK_FILE" true 2>/dev/null; then echo "restart: lock free" >>"$STUB_DIR/calls.log"; else echo "restart: lock held" >>"$STUB_DIR/calls.log"; fi
    echo up >"$STUB_DIR/health" ;;
  list-units*) cat "$STUB_DIR/units" 2>/dev/null ;;
  "show -p MainPID --value paperclip-native.service") cat "$STUB_DIR/mainpid" ;;
  "show -p ControlGroup --value paperclip-native.service") echo /system.slice/paperclip-native.service ;;
esac
exit 0
EOF
chmod +x "$BIN/curl" "$BIN/systemctl"
export STUB_DIR="$WORKDIR/stub"
mkdir -p "$STUB_DIR"

# stubbed <command...>: runs <command...> with only the stubs for
# systemctl/curl, no BASH_ENV, and a hard check that the stubs resolve.
# shellcheck disable=SC2016 # the inner bash expands these, not this one
stubbed() {
  env -u BASH_ENV STUB_BIN="$BIN" bash -c '
    PATH="$STUB_BIN:$PATH"
    [[ "$(command -v systemctl)" == "$STUB_BIN/systemctl" && "$(command -v curl)" == "$STUB_BIN/curl" ]] \
      || { echo "stubs not on PATH; refusing to run" >&2; exit 99; }
    "$@"
  ' stubbed "$@"
}

restarts() { grep -c '^systemctl restart paperclip-native.service$' "$STUB_DIR/calls.log" || true; }

# --- A. paperclip-recover.sh ---------------------------------------------------
ROOT="$WORKDIR/root"
mkdir -p "$ROOT/logs"
export PAPERCLIP_NATIVE_ROOT="$ROOT" PORT=3101 STUB_LOCK_FILE="$ROOT/logs/.paperclip-update.lock"
export PAPERCLIP_RECOVER_PROBE_DELAY=0 PAPERCLIP_RECOVER_HEALTH_DELAY=0 PAPERCLIP_RECOVER_HEALTH_ATTEMPTS=2

recover() {
  set +e
  REC_OUT="$(stubbed bash "$SCRIPTS_DIR/paperclip-recover.sh" 2>&1)"
  REC_RC=$?
  set -e
  [[ "$REC_RC" -ne 99 ]] || fail "recover: the stubs were not on PATH: $REC_OUT"
}

# A1. An update holds the lock: no probe-driven restart even though down.
echo down >"$STUB_DIR/health"; : >"$STUB_DIR/calls.log"
# One process holds the lock (the subshell execs sleep with fd 8 still
# open), so killing LOCK_HOLDER really releases it.
( exec 8>"$ROOT/logs/.paperclip-update.lock"; flock 8; exec sleep 60 ) &
LOCK_HOLDER=$!
for _ in $(seq 1 50); do
  flock -n "$ROOT/logs/.paperclip-update.lock" true 2>/dev/null || break
  sleep 0.1
done
recover
kill "$LOCK_HOLDER" 2>/dev/null; wait "$LOCK_HOLDER" 2>/dev/null || true; LOCK_HOLDER=""
[[ "$REC_RC" -eq 0 && "$(restarts)" -eq 0 ]] || fail "A1: expected no restart while the update lock is held (rc=$REC_RC). $REC_OUT"
printf '%s\n' "$REC_OUT" | grep -q "an update is running" || fail "A1: did not report the held lock. $REC_OUT"
flock -n "$ROOT/logs/.paperclip-update.lock" true || fail "A1: the test's lock holder did not release the lock"
echo "PASS: recover stands back while paperclip-update.sh holds its lock"

# A2. The second probe answers: no restart.
echo up >"$STUB_DIR/health"; : >"$STUB_DIR/calls.log"
recover
[[ "$REC_RC" -eq 0 && "$(restarts)" -eq 0 ]] || fail "A2: restarted although the second probe answered (rc=$REC_RC). $REC_OUT"
printf '%s\n' "$REC_OUT" | grep -q "Second probe OK" || fail "A2: did not take the second-probe path. $REC_OUT"
echo "PASS: recover leaves a server alone when the second probe answers"

# A3. Down on the second probe: one restart, then healthy.
echo down >"$STUB_DIR/health"; : >"$STUB_DIR/calls.log"
recover
[[ "$REC_RC" -eq 0 && "$(restarts)" -eq 1 ]] || fail "A3: expected exactly one restart after two failed probes (rc=$REC_RC). $REC_OUT"
[[ -s "$ROOT/logs/.paperclip-recover.last-restart" ]] || fail "A3: the restart time was not recorded. $REC_OUT"
echo "PASS: recover restarts after two consecutive failed probes"

# A4. Down again a moment later: rate-limited, exits non-zero to alert.
echo down >"$STUB_DIR/health"; : >"$STUB_DIR/calls.log"
recover
[[ "$REC_RC" -ne 0 && "$(restarts)" -eq 0 ]] || fail "A4: expected no second restart within 15 minutes and a non-zero exit (rc=$REC_RC). $REC_OUT"
printf '%s\n' "$REC_OUT" | grep -q "at most once per 900s" || fail "A4: the rate-limit message is missing. $REC_OUT"
echo "PASS: recover restarts at most once per 15 minutes and fails (alerts) when rate-limited"

# A5. Fifteen minutes later it may restart again.
echo $(($(date +%s) - 901)) >"$ROOT/logs/.paperclip-recover.last-restart"
echo down >"$STUB_DIR/health"; : >"$STUB_DIR/calls.log"
recover
[[ "$REC_RC" -eq 0 && "$(restarts)" -eq 1 ]] || fail "A5: expected a restart once 15 minutes had passed (rc=$REC_RC). $REC_OUT"
echo "PASS: recover restarts again once 15 minutes have passed"

# A6. The recovery unit holds the update lock through the restart: an
# updater that tries to start while it restarts is refused.
echo down >"$STUB_DIR/health"; : >"$STUB_DIR/calls.log"
echo $(($(date +%s) - 901)) >"$ROOT/logs/.paperclip-recover.last-restart"
recover
[[ "$REC_RC" -eq 0 && "$(restarts)" -eq 1 ]] || fail "A6: expected one restart (rc=$REC_RC). $REC_OUT"
grep -q '^restart: lock held$' "$STUB_DIR/calls.log" || fail "A6: the update lock was free while the server was restarted (an update could start mid-restart). $(cat "$STUB_DIR/calls.log")"
flock -n "$ROOT/logs/.paperclip-update.lock" true || fail "A6: recover did not release the update lock when it finished"
echo "PASS: recover holds the update lock through the final health re-check and the restart, and releases it after"

# A7. An updater takes the lock after the second probe failed but before
# recover locks: recover must not restart over it.
echo down >"$STUB_DIR/health"; : >"$STUB_DIR/calls.log"
echo $(($(date +%s) - 901)) >"$ROOT/logs/.paperclip-recover.last-restart"
printf '%s\n' '#!/usr/bin/env bash' \
  "( exec 8>\"$ROOT/logs/.paperclip-update.lock\"; flock 8; exec sleep 60 ) &" \
  "echo \$! >\"$STUB_DIR/holder.pid\"" \
  "for _ in \$(seq 1 50); do flock -n \"$ROOT/logs/.paperclip-update.lock\" true 2>/dev/null || exit 0; sleep 0.1; done" \
  >"$STUB_DIR/on-first-probe"
chmod +x "$STUB_DIR/on-first-probe"
recover
LOCK_HOLDER="$(cat "$STUB_DIR/holder.pid")"
kill "$LOCK_HOLDER" 2>/dev/null; wait "$LOCK_HOLDER" 2>/dev/null || true; LOCK_HOLDER=""
[[ "$REC_RC" -eq 0 && "$(restarts)" -eq 0 ]] || fail "A7: restarted although an update took the lock first (rc=$REC_RC). $REC_OUT"
printf '%s\n' "$REC_OUT" | grep -q "An update started while this check waited" || fail "A7: did not report the lock taken by the update. $REC_OUT"
echo "PASS: recover does not restart when an update takes the lock before it does"

# A8. Under the lock it stops a build scope left by a SIGKILLed updater,
# before the restart.
echo down >"$STUB_DIR/health"; : >"$STUB_DIR/calls.log"
echo $(($(date +%s) - 901)) >"$ROOT/logs/.paperclip-recover.last-restart"
printf '%s\n' 'paperclip-build-0123456789ab.scope loaded active running Transient scope' \
  '● paperclip-build-probe-77.scope loaded failed failed Transient scope' \
  'something-else.scope loaded active running Other' >"$STUB_DIR/units"
recover
rm -f "$STUB_DIR/units"
grep -q '^systemctl stop paperclip-build-0123456789ab.scope$' "$STUB_DIR/calls.log" || fail "A8: the leftover build scope was not stopped. $(cat "$STUB_DIR/calls.log")"
grep -q '^systemctl stop paperclip-build-probe-77.scope$' "$STUB_DIR/calls.log" || fail "A8: the leftover (failed) probe scope was not stopped. $(cat "$STUB_DIR/calls.log")"
grep -q 'stop something-else' "$STUB_DIR/calls.log" && fail "A8: stopped a scope that is not a build scope"
stop_line="$(grep -n '^systemctl stop paperclip-build-0123456789ab.scope$' "$STUB_DIR/calls.log" | head -1 | cut -d: -f1)"
restart_line="$(grep -n '^systemctl restart paperclip-native.service$' "$STUB_DIR/calls.log" | head -1 | cut -d: -f1)"
[[ -n "$restart_line" && "$stop_line" -lt "$restart_line" ]] || fail "A8: the scope was not stopped before the restart. $(cat "$STUB_DIR/calls.log")"
echo "PASS: recover stops build scopes left by a killed updater before it restarts the server"

# --- B. paperclip-oom-guard.sh (one pass) --------------------------------------
FAKE_PROC="$WORKDIR/proc"
FAKE_CG="$WORKDIR/cgroup"
mkdir -p "$FAKE_CG/system.slice/paperclip-native.service"
# fake_proc <pid> <adj> <comm> <exe>
fake_proc() {
  mkdir -p "$FAKE_PROC/$1"
  echo "$2" >"$FAKE_PROC/$1/oom_score_adj"
  echo "$3" >"$FAKE_PROC/$1/comm"
  ln -sfn "$4" "$FAKE_PROC/$1/exe"
  echo "$1" >>"$FAKE_CG/system.slice/paperclip-native.service/cgroup.procs"
}
fake_proc 100 0 MainThread /root/toolchain/node/bin/node
fake_proc 101 -500 postgres /root/releases/x/node_modules/.pnpm/p/node_modules/@embedded-postgres/linux-x64/native/bin/postgres
fake_proc 102 -500 claude /root/toolchain/node/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
fake_proc 103 300 bash /usr/bin/bash
echo 100 >"$STUB_DIR/mainpid"
set +e
OOM_OUT="$(PAPERCLIP_PROC_ROOT="$FAKE_PROC" PAPERCLIP_CGROUP_ROOT="$FAKE_CG" PAPERCLIP_OOM_GUARD_ONCE=1 \
  stubbed bash "$SCRIPTS_DIR/paperclip-oom-guard.sh" 2>&1)"
OOM_RC=$?
set -e
[[ "$OOM_RC" -eq 0 ]] || fail "B: the OOM guard pass failed (rc=$OOM_RC): $OOM_OUT"
adj() { cat "$FAKE_PROC/$1/oom_score_adj"; }
[[ "$(adj 100)" == "-500" ]] || fail "B: server main process not protected (got $(adj 100)). $OOM_OUT"
[[ "$(adj 101)" == "-500" ]] || fail "B: embedded Postgres not protected (got $(adj 101)). $OOM_OUT"
[[ "$(adj 102)" == "0" ]] || fail "B: agent process kept the inherited -500 (got $(adj 102)); it must not be more protected than Tailscale/networking (0). $OOM_OUT"
[[ "$(adj 103)" == "300" ]] || fail "B: the guard lowered a process that was already above 0 (got $(adj 103)). $OOM_OUT"
echo "PASS: OOM guard protects the server and Postgres (-500) and raises agent processes that inherited it back to 0"

# B2. New agents inherit -500 at fork; the running guard (default interval)
# must reset them within a fraction of a second, not seconds.
fake_proc 103 300 bash /usr/bin/bash
(
  export PAPERCLIP_PROC_ROOT="$FAKE_PROC" PAPERCLIP_CGROUP_ROOT="$FAKE_CG"
  # shellcheck disable=SC2016 # the inner bash expands $STUB_BIN and $PATH
  exec env -u BASH_ENV STUB_BIN="$BIN" bash -c 'PATH="$STUB_BIN:$PATH"; exec "$0"' "$SCRIPTS_DIR/paperclip-oom-guard.sh"
) >"$WORKDIR/guard-loop.out" 2>&1 &
GUARD_PID=$!
sleep 0.5
fake_proc 104 -500 claude /root/toolchain/node/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
start_ns="$(date +%s%N)"
reset_ms=""
for _ in $(seq 1 200); do
  if [[ "$(adj 104)" == "0" ]]; then reset_ms=$((($(date +%s%N) - start_ns) / 1000000)); break; fi
  sleep 0.01
done
kill "$GUARD_PID" 2>/dev/null; wait "$GUARD_PID" 2>/dev/null || true
[[ -n "$reset_ms" ]] || fail "B2: the running OOM guard never reset a new process that inherited -500. $(cat "$WORKDIR/guard-loop.out")"
[[ "$reset_ms" -le 1000 ]] || fail "B2: the guard took ${reset_ms}ms to reset a new process that inherited -500 (limit 1000ms). $(cat "$WORKDIR/guard-loop.out")"
grep -q 'PAPERCLIP_OOM_GUARD_INTERVAL:-0.2' "$SCRIPTS_DIR/paperclip-oom-guard.sh" || fail "B2: the default guard interval is no longer 0.2s"
echo "PASS: the running OOM guard resets a new process that inherited -500 within ${reset_ms}ms (default interval 0.2s)"

# --- C. install_safety_net -------------------------------------------------------
INSTALL_ROOT="$WORKDIR/install root"
mkdir -p "$INSTALL_ROOT/logs" "$INSTALL_ROOT/recovery/scripts"
: >"$STUB_DIR/calls.log"
# shellcheck disable=SC2016 # the inner bash expands these, not this one
install_once() {
  set +e
  INST_OUT="$(PAPERCLIP_SYSTEMD_DIR="$WORKDIR/etc-systemd" stubbed bash -c '
    source "$1"; DRY_RUN=0
    install_safety_net "$2" "$3" "$4" "$5"
  ' x "$NATIVE_DIR/lib/common.sh" "$ZIMAOS_DIR" "$INSTALL_ROOT" "$WORKDIR" "$INSTALL_ROOT/recovery" 2>&1)"
  INST_RC=$?
  set -e
  [[ "$INST_RC" -eq 0 ]] || fail "C: install_safety_net failed (rc=$INST_RC): $INST_OUT"
}
install_once
for f in "${SAFETY_NET_UNITS[@]}"; do
  [[ -f "$WORKDIR/etc-systemd/$f" ]] || fail "C: $f was not installed. $INST_OUT"
done
for f in "${SAFETY_NET_SCRIPTS[@]}"; do
  [[ -x "$INSTALL_ROOT/recovery/scripts/$f" ]] || fail "C: $f was not installed executable. $INST_OUT"
done
grep -qF "ExecStart=\"$INSTALL_ROOT/recovery/scripts/paperclip-recover.sh\"" "$WORKDIR/etc-systemd/paperclip-native-recover.service" \
  || fail "C: the recover unit was not rendered for this root/recovery base: $(cat "$WORKDIR/etc-systemd/paperclip-native-recover.service")"
grep -q "External SSD" "$WORKDIR/etc-systemd/paperclip-native-recover.service" \
  && fail "C: the rendered recover unit still names the default root"
[[ "$(grep -c '^systemctl daemon-reload$' "$STUB_DIR/calls.log")" -eq 1 ]] || fail "C: expected one daemon-reload on the first install. $(cat "$STUB_DIR/calls.log")"
: >"$STUB_DIR/calls.log"
install_once
grep -q '^systemctl daemon-reload$' "$STUB_DIR/calls.log" && fail "C: a second install with nothing changed ran daemon-reload again"
grep -q '^systemctl restart' "$STUB_DIR/calls.log" && fail "C: install_safety_net restarted something"
printf '%s\n' "$INST_OUT" | grep -q "already up to date" || fail "C: the second install did not report nothing to do. $INST_OUT"
echo "PASS: install_safety_net renders for the host, installs only what changed, reloads only when a unit changed, never restarts"

# --- C2. The rendered units with a root that has a space in it -----------------
# The documented default root is /DATA/.media/External SSD/paperclip-native,
# and install renders the recovery path under it when /usr/local/lib is not
# writable. An unquoted ExecStart= splits at the space ("Command
# /DATA/.media/External is not executable"). Render exactly that, build a
# fake root holding real files at the exact full paths (no stub at the
# truncated path), and require systemd-analyze verify to exit 0.
command -v systemd-analyze >/dev/null 2>&1 || fail "C2: systemd-analyze is not installed; cannot verify the rendered units"
# render_and_verify <out-dir> <strip-quotes: 0|1>: prints the verify output,
# returns non-zero if systemd-analyze rejects either unit.
render_and_verify() {
  local out="$1" strip="$2" root="$UNIT_DEFAULT_ROOT" f unit rc=0 fr="$1/fr"
  mkdir -p "$fr/etc/systemd/system" "$fr/usr/lib" "$fr$root/env" "$fr$root/recovery/scripts" "$fr/usr/local/lib/paperclip/scripts"
  cp -rL /usr/lib/systemd "$fr/usr/lib/systemd" 2>/dev/null || true
  for f in "${SAFETY_NET_UNITS[@]}"; do
    mkdir -p "$out/$(dirname "$f")" "$fr/etc/systemd/system/$(dirname "$f")"
    render_unit_file "$ZIMAOS_DIR/systemd/$f" "$out/$f" "$root" "$UNIT_DEFAULT_MOUNT_PATH" "$root/recovery"
    [[ "$strip" == "1" ]] && sed -i -E 's/^(ExecStart=)"(.*)"$/\1\2/' "$out/$f"
    cp "$out/$f" "$fr/etc/systemd/system/$f"
  done
  for f in paperclip-recover.sh paperclip-oom-guard.sh; do
    printf '#!/bin/sh\n' >"$fr$root/recovery/scripts/$f"
    chmod +x "$fr$root/recovery/scripts/$f"
  done
  : >"$fr$root/env/paperclip-native.env"
  : >"$fr$root/env/telegram.env"
  # The alert template the recover unit names in OnFailure=.
  cp "$ZIMAOS_DIR/systemd/paperclip-native-alert@.service" "$fr/etc/systemd/system/"
  printf '#!/bin/sh\n' >"$fr/usr/local/lib/paperclip/scripts/telegram-alert.sh"
  chmod +x "$fr/usr/local/lib/paperclip/scripts/telegram-alert.sh"
  for unit in paperclip-native-recover.service paperclip-native-oom-guard.service; do
    systemd-analyze verify --root="$fr" "$unit" 2>&1 | grep -v 'is not a symlink, ignoring' || true
    systemd-analyze verify --root="$fr" "$unit" >/dev/null 2>&1 || rc=1
  done
  return "$rc"
}
set +e
VERIFY_OUT="$(render_and_verify "$WORKDIR/c2-quoted" 0)"
VERIFY_RC=$?
set -e
[[ "$VERIFY_RC" -eq 0 ]] || fail "C2: systemd-analyze verify rejected the recover/oom-guard units rendered for '$UNIT_DEFAULT_ROOT': $VERIFY_OUT"
echo "PASS: the recover and OOM-guard units rendered for a root with a space pass systemd-analyze verify"
# Negative control: the same units with the quotes removed must fail, so
# this check really can see the bug.
set +e
VERIFY_OUT="$(render_and_verify "$WORKDIR/c2-unquoted" 1)"
VERIFY_RC=$?
set -e
[[ "$VERIFY_RC" -ne 0 ]] || fail "C2: the control (ExecStart without quotes) passed verification, so this check cannot see an unquoted path"
printf '%s\n' "$VERIFY_OUT" | grep -q "External is not executable" || fail "C2: the control failed for another reason: $VERIFY_OUT"
echo "PASS: control: the same units with ExecStart unquoted fail verification ('/DATA/.media/External is not executable')"
