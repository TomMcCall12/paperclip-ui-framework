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
[[ "$(cat "$STUB_DIR/health")" == "up" ]]
EOF
cat >"$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >>"$STUB_DIR/calls.log"
case "$*" in
  "restart paperclip-native.service") echo up >"$STUB_DIR/health" ;;
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
export PAPERCLIP_NATIVE_ROOT="$ROOT" PORT=3101
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
grep -qF "ExecStart=$INSTALL_ROOT/recovery/scripts/paperclip-recover.sh" "$WORKDIR/etc-systemd/paperclip-native-recover.service" \
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
