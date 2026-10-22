#!/usr/bin/env bash
# Offline test (TOM-782): the heartbeat timer is stopped before the restart and
# started again only after health passes, so a deploy sends no false /fail ping.
# Covers pause_heartbeat / resume_heartbeat, the exit trap, and paperclip-update.sh wiring.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIMAOS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
NATIVE_DIR="$(cd "$ZIMAOS_DIR/.." && pwd)"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(make_exec_capable_tempdir paperclip-hb-pause-test "$NATIVE_DIR")"
trap 'rm -rf "$WORKDIR"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$WORKDIR/bin"
cat >"$WORKDIR/bin/curl" <<'EOF2'
#!/usr/bin/env bash
[[ "$(cat "$STUB_DIR/health")" == "up" ]]
EOF2
cat >"$WORKDIR/bin/systemctl" <<'EOF2'
#!/usr/bin/env bash
echo "systemctl $*" >>"$STUB_DIR/calls.log"
case "${1:-}" in
  is-active) [[ "$(cat "$STUB_DIR/timer")" == "active" ]]; exit $? ;;
  restart) [[ -e "$STUB_DIR/stuck" ]] || echo up >"$STUB_DIR/health" ;;
esac
exit 0
EOF2
chmod +x "$WORKDIR/bin/curl" "$WORKDIR/bin/systemctl"

# run_case <name> <timer-state> <health> <body>   (body runs in a child that sourced common.sh)
run_case() {
  local name="$1" timer="$2" health="$3" body="$4" d="$WORKDIR/$1"
  mkdir -p "$d"; echo "$timer" >"$d/timer"; echo "$health" >"$d/health"; : >"$d/calls.log"
  set +e
  CASE_OUT="$(STUB_DIR="$d" env -u BASH_ENV bash -c '
    PATH="$1:$PATH"
    [[ "$(command -v systemctl)" == "$1/systemctl" ]] || { echo "stub not first on PATH"; exit 99; }
    source "$2"; DRY_RUN=0
    UPDATE_HEALTH_URL=http://stub/health UPDATE_SERVICE=paperclip-native.service
    UPDATE_HEALTH_ATTEMPTS=1 UPDATE_HEALTH_DELAY=0 UPDATE_CURRENT_LINK="" UPDATE_PREV_RELEASE=""
    eval "$3"
  ' x "$WORKDIR/bin" "$NATIVE_DIR/lib/common.sh" "$body" 2>&1)"
  CASE_RC=$?
  set -e
  CASE_CALLS="$(cat "$d/calls.log")"
}
has() { grep -qF -- "$1" <<<"$CASE_CALLS"; }
line_of() { grep -nF -- "$1" <<<"$CASE_CALLS" | head -1 | cut -d: -f1; }

# shellcheck disable=SC2016 # bodies are expanded by the child shell
# A. active timer: pause stops it; resume starts it, after the restart.
run_case A active down 'pause_heartbeat; systemctl restart paperclip-native.service; resume_heartbeat'
[[ $CASE_RC -eq 0 ]] || fail "A: rc=$CASE_RC $CASE_OUT"
has "systemctl stop paperclip-native-heartbeat.timer" || fail "A: timer not stopped: $CASE_CALLS"
[[ "$(line_of 'stop paperclip-native-heartbeat.timer')" -lt "$(line_of 'restart paperclip-native.service')" ]] || fail "A: stop not before restart"
[[ "$(line_of 'restart paperclip-native.service')" -lt "$(line_of 'start paperclip-native-heartbeat.timer')" ]] || fail "A: start not after restart"
echo "PASS: A active timer is stopped before the restart and started after"

# B. inactive timer (a person disabled it): neither stop nor start.
run_case B inactive up 'pause_heartbeat; resume_heartbeat'
has "stop paperclip-native-heartbeat" && fail "B: stopped an inactive timer"
has "start paperclip-native-heartbeat" && fail "B: started a timer that was off"
echo "PASS: B an inactive timer stays off"

# C. exit trap with a healthy server resumes; with a server that stays down it does not.
run_case C active up 'pause_heartbeat; UPDATE_PHASE=restarted; update_exit_safety_net 1'
has "start paperclip-native-heartbeat.timer" || fail "C: not resumed after healthy exit: $CASE_CALLS"
mkdir -p "$WORKDIR/D"; touch "$WORKDIR/D/stuck"
run_case D active down 'pause_heartbeat; UPDATE_PHASE=restarted; update_exit_safety_net 1'
has "start paperclip-native-heartbeat.timer" && fail "D: resumed although the server is still down: $CASE_CALLS"
echo "PASS: C/D the exit trap resumes only when the server is healthy"

# E. first install: enabled without --now; resume starts it.
IR="$WORKDIR/ir"; mkdir -p "$IR/logs" "$IR/recovery/scripts"
run_case E inactive up "PAPERCLIP_SYSTEMD_DIR='$WORKDIR/etc' install_safety_net '$ZIMAOS_DIR' '$IR' '$WORKDIR' '$IR/recovery'; echo RESUME=\$HEARTBEAT_RESUME; resume_heartbeat"
grep -q 'RESUME=1' <<<"$CASE_OUT" || fail "E: deferred start not recorded: $CASE_OUT"
has "systemctl enable paperclip-native-heartbeat.timer" || fail "E: not enabled: $CASE_CALLS"
has "enable --now paperclip-native-heartbeat.timer" && fail "E: started on first install"
has "enable --now paperclip-native-net-heal.timer" || fail "E: other timers lost --now"
has "start paperclip-native-heartbeat.timer" || fail "E: not started on resume"
echo "PASS: E first install enables without --now and starts on resume"

# F. wiring in paperclip-update.sh: pause before the switch, resume after both health passes.
U="$ZIMAOS_DIR/paperclip-update.sh"
pl="$(grep -n '^pause_heartbeat' "$U" | cut -d: -f1)"; sl="$(grep -n '== Switch current and restart' "$U" | cut -d: -f1)"
[[ -n "$pl" && "$pl" -lt "$sl" ]] || fail "F: pause_heartbeat is not before the switch"
[[ "$(grep -c '^ *resume_heartbeat' "$U")" -eq 2 ]] || fail "F: expected resume_heartbeat after the health pass and after the rollback"
echo "PASS: F paperclip-update.sh pauses before the switch and resumes after health (update and rollback)"
