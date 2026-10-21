#!/usr/bin/env bash
# Offline test for the TOM-690 host checks, no root needed:
#   A. paperclip-net-heal.sh: leaves a port with an address alone; does
#      nothing without a cable link; waits out the grace period; then takes
#      one step per interval (connect, link bounce, NetworkManager restart)
#      and starts again; reboots only when turned on and allowed; starts a
#      fresh outage on a new boot; logs when the network is back.
#   B. paperclip-netwatch.sh: passes on a healthy path; fails (exit 1) on no
#      address, no LAN health, no DNS or no internet; a single blip passes.
#   C. paperclip-quiet-restart.sh: skips when not needed, while an update
#      runs, and while agent runs stay busy; restarts an idle, grown server
#      under the update lock.
#   D. install_safety_net: installs the new scripts and units and enables
#      each new timer only on its first install.
# ip, nmcli, systemctl, curl, getent and sleep are stubs; each child
# refuses to run unless they resolve to the stubs (a BASH_ENV startup file
# can reset PATH). Nothing here touches a real network interface.
#
# Usage: test-network-safety-net.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIMAOS_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
NATIVE_DIR="$(cd "$ZIMAOS_DIR/.." && pwd)"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(make_exec_capable_tempdir paperclip-network-test "$NATIVE_DIR")"
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
export STUB_DIR="$WORKDIR/stub"
mkdir -p "$BIN" "$STUB_DIR"
cat >"$BIN/ip" <<'EOF'
#!/usr/bin/env bash
# ip-rc (optional): make the address and route queries fail with that exit code.
ip_fails() {
  if [[ -s "$STUB_DIR/ip-rc" ]]; then echo "RTNETLINK answers: stub failure" >&2; exit "$(cat "$STUB_DIR/ip-rc")"; fi
}
case "$*" in
  "-4 -o addr show dev eth0 scope global")
    ip_fails
    [[ "$(cat "$STUB_DIR/addr")" == "yes" ]] && echo "2: eth0    inet 192.168.0.163/24 brd 192.168.0.255 scope global dynamic noprefixroute eth0" ;;
  "-4 route show default dev eth0")
    ip_fails
    [[ "$(cat "$STUB_DIR/route")" == "yes" ]] && echo "default via 192.168.0.1 proto dhcp src 192.168.0.163 metric 100" ;;
  *) echo "ip $*" >>"$STUB_DIR/calls.log" ;;
esac
exit 0
EOF
cat >"$BIN/nmcli" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == "-g CONNECTIONS.AVAILABLE-CONNECTIONS device show eth0" ]]; then
  [[ "$(cat "$STUB_DIR/nm-profile" 2>/dev/null || echo yes)" == "yes" ]] && echo "e73b6d7b-125a-3850-b12d-8429ffde8b9c | Wired connection 1"
  exit 0
fi
echo "nmcli $*" >>"$STUB_DIR/calls.log"
exit "$(cat "$STUB_DIR/nmcli-rc" 2>/dev/null || echo 0)"
EOF
cat >"$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "show -p MainPID --value "*) cat "$STUB_DIR/mainpid" ;;
  "show -p ControlGroup --value "*) echo /system.slice/paperclip-native.service ;;
  "show -p ActiveEnterTimestampMonotonic --value "*) cat "$STUB_DIR/started-us" ;;
  "restart paperclip-native.service")
    echo "systemctl $*" >>"$STUB_DIR/calls.log"
    if flock -n "$STUB_LOCK_FILE" true 2>/dev/null; then echo "restart: lock free" >>"$STUB_DIR/calls.log"; else echo "restart: lock held" >>"$STUB_DIR/calls.log"; fi ;;
  *) echo "systemctl $*" >>"$STUB_DIR/calls.log" ;;
esac
exit 0
EOF
cat >"$BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >>"$STUB_DIR/curl.log"
for a in "$@"; do
  case "$a" in
    http://127.0.0.1:*) [[ "$(cat "$STUB_DIR/health")" == "up" ]]; exit ;;
    http://192.168.0.163:*) [[ "$(cat "$STUB_DIR/lan-health")" == "up" ]]; exit ;;
    https://*) [[ "$(cat "$STUB_DIR/https")" == "up" ]]; exit ;;
  esac
done
exit 7
EOF
cat >"$BIN/getent" <<'EOF'
#!/usr/bin/env bash
state="$(cat "$STUB_DIR/dns")"
# "blip": fail once, then work.
if [[ "$state" == "blip" ]]; then echo up >"$STUB_DIR/dns"; exit 2; fi
[[ "$state" == "up" ]]
EOF
cat >"$BIN/sleep" <<'EOF'
#!/usr/bin/env bash
echo "sleep $*" >>"$STUB_DIR/sleep.log"
# Optional hook: runs on every sleep (used to let agent runs finish).
[[ -x "$STUB_DIR/on-sleep" ]] && "$STUB_DIR/on-sleep"
exit 0
EOF
chmod +x "$BIN"/*

# stubbed <command...>: runs <command...> with only the stubs on PATH first,
# no BASH_ENV, and a hard check that every stub resolves.
# shellcheck disable=SC2016 # the inner bash expands these, not this one
stubbed() {
  env -u BASH_ENV STUB_BIN="$BIN" bash -c '
    PATH="$STUB_BIN:$PATH"
    for c in ip nmcli systemctl curl getent sleep; do
      [[ "$(command -v "$c")" == "$STUB_BIN/$c" ]] || { echo "stub $c not on PATH; refusing to run" >&2; exit 99; }
    done
    "$@"
  ' stubbed "$@"
}

export -f stubbed
export BIN

# --- A. paperclip-net-heal.sh ------------------------------------------------
ROOT="$WORKDIR/root"
mkdir -p "$ROOT/logs" "$WORKDIR/sys/eth0"
echo boot-1 >"$WORKDIR/boot_id"
echo "100000.00 1.00" >"$WORKDIR/uptime"
export STUB_LOCK_FILE="$ROOT/logs/.paperclip-update.lock"

# hold_update_lock / release_update_lock: hold the update lock the way a
# running paperclip-update.sh does. One process (exec sleep), output
# detached, so the kill releases the lock and nothing holds this test's
# stdout open.
hold_update_lock() {
  # shellcheck disable=SC2093 # exec on purpose: one process holds the lock
  (exec 7>>"$STUB_LOCK_FILE"; flock 7; exec sleep 600) >/dev/null 2>&1 &
  LOCK_HOLDER=$!
  local i
  for i in $(seq 100); do
    flock -n "$STUB_LOCK_FILE" true 2>/dev/null || return 0
    command sleep 0.05
  done
  fail "could not take the update lock for the test"
}
release_update_lock() {
  kill "$LOCK_HOLDER" 2>/dev/null || true
  wait "$LOCK_HOLDER" 2>/dev/null || true
  LOCK_HOLDER=""
}

# heal <now> [VAR=value...]: one timer run at time <now>.
# shellcheck disable=SC2016 # the inner bash expands "$0", not this one
heal() {
  local t="$1"
  shift
  set +e
  HEAL_OUT="$(env PAPERCLIP_NATIVE_ROOT="$ROOT" PAPERCLIP_SYS_CLASS_NET="$WORKDIR/sys" \
    PAPERCLIP_BOOT_ID_FILE="$WORKDIR/boot_id" PAPERCLIP_UPTIME_FILE="$WORKDIR/uptime" \
    PAPERCLIP_NOW="$t" PAPERCLIP_NET_HEAL_BOUNCE_DELAY=0 "$@" \
    bash -c 'stubbed "$0"' "$SCRIPTS_DIR/paperclip-net-heal.sh" 2>&1)"
  HEAL_RC=$?
  set -e
  [[ "$HEAL_RC" -eq "${HEAL_WANT_RC:-0}" ]] || fail "A: net-heal exited $HEAL_RC (wanted ${HEAL_WANT_RC:-0}) at t=$t: $HEAL_OUT"
}
set_net() { echo "$1" >"$STUB_DIR/addr"; echo "$2" >"$STUB_DIR/route"; echo "$3" >"$WORKDIR/sys/eth0/carrier"; }
calls() { cat "$STUB_DIR/calls.log" 2>/dev/null || true; }
reset_calls() { : >"$STUB_DIR/calls.log"; }

# A1: healthy port, no state: nothing at all.
set_net yes yes 1
reset_calls
heal 1000
[[ -z "$(calls)" ]] || fail "A1: a port with an address was touched: $(calls)"
[[ ! -e "$ROOT/logs/.paperclip-net-heal.state" ]] || fail "A1: a healthy port left outage state"
echo "PASS: A1 a port with an address and a default route is left alone"

# A2: no cable link: logged once, never acted on, even after a long time.
set_net no no 0
reset_calls
heal 1000
heal 2000
heal 5000
[[ -z "$(calls)" ]] || fail "A2: acted without a cable link: $(calls)"
[[ "$(grep -c 'no cable link' "$ROOT/logs/network-heal.log")" -eq 1 ]] || fail "A2: expected one no-cable-link log line: $(cat "$ROOT/logs/network-heal.log")"
echo "PASS: A2 no cable link: logged once, no action"

# A3: link comes up, still no address: grace period first (counted from link-up).
set_net no no 1
heal 5060
heal 5300
[[ -z "$(calls)" ]] || fail "A3: acted inside the grace period: $(calls)"
echo "PASS: A3 nothing happens inside the 5-minute grace period (counted from link-up)"

# A4: grace over: step 1, then nothing until the step interval has passed.
heal 5360
grep -qx 'nmcli --wait 60 device connect eth0' <<<"$(calls)" || fail "A4: step 1 did not run nmcli device connect: $(calls)"
reset_calls
heal 5420
heal 5600
[[ -z "$(calls)" ]] || fail "A4: a second step ran before the step interval: $(calls)"
echo "PASS: A4 after the grace period: step 1 (nmcli device connect), then a wait"

# A5: step 2 is a link bounce in order.
heal 5660
expected=$'nmcli --wait 20 device disconnect eth0\nip link set dev eth0 down\nip link set dev eth0 up\nnmcli --wait 60 device connect eth0'
[[ "$(calls)" == "$expected" ]] || fail "A5: step 2 was not disconnect/down/up/connect: $(calls)"
reset_calls
echo "PASS: A5 step 2 bounces the link (disconnect, down, up, connect)"

# A6: step 3 restarts NetworkManager; then the round starts again at step 1.
heal 5960
[[ "$(calls)" == "systemctl restart NetworkManager" ]] || fail "A6: step 3 was not a NetworkManager restart: $(calls)"
reset_calls
heal 6260
grep -qx 'nmcli --wait 60 device connect eth0' <<<"$(calls)" || fail "A6: the fourth step did not start a new round at step 1: $(calls)"
grep -q reboot <<<"$(calls)" && fail "A6: rebooted although the reboot step is off"
reset_calls
echo "PASS: A6 step 3 restarts NetworkManager; the round repeats; no reboot while it is off"

# A7: a failing step is logged and does not stop the next run.
echo 10 >"$STUB_DIR/nmcli-rc"
heal 6560
heal 6860
echo 0 >"$STUB_DIR/nmcli-rc"
grep -q 'returned exit 10' "$ROOT/logs/network-heal.log" || fail "A7: a failed step was not logged"
reset_calls
echo "PASS: A7 a failing step is logged and the next step still runs"

# A8: reboot step, when on: refused during an update, then taken once, then rate-limited.
REBOOT_ENV=(PAPERCLIP_NET_HEAL_REBOOT=1 PAPERCLIP_NET_HEAL_REBOOT_AFTER=1800)
hold_update_lock
heal 7500 "${REBOOT_ENV[@]}"
grep -q reboot <<<"$(calls)" && fail "A8: rebooted while an update held its lock"
grep -q 'Not rebooting during an update' "$ROOT/logs/network-heal.log" || fail "A8: the update-lock refusal was not logged"
release_update_lock
reset_calls
heal 7800 "${REBOOT_ENV[@]}"
[[ "$(calls)" == "systemctl reboot" ]] || fail "A8: expected exactly one reboot: $(calls)"
reset_calls
heal 8100 "${REBOOT_ENV[@]}"
grep -q reboot <<<"$(calls)" && fail "A8: rebooted twice inside the minimum interval"
[[ -n "$(calls)" ]] || fail "A8: after a refused reboot the other steps stopped"
reset_calls
echo "PASS: A8 reboot step (when on): not during an update, once, then rate-limited while the other steps go on"

# A9: a new boot starts a fresh outage (no step before its own grace period).
echo boot-2 >"$WORKDIR/boot_id"
heal 9000
heal 9200
[[ -z "$(calls)" ]] || fail "A9: a new boot acted before its grace period: $(calls)"
echo "PASS: A9 a new boot starts a fresh grace period"

# A10: the address comes back: outage end logged, state cleared, nothing run.
set_net yes yes 1
heal 9400
[[ -z "$(calls)" ]] || fail "A10: acted on a recovered port: $(calls)"
grep -q 'Network back on eth0, 400s after' "$ROOT/logs/network-heal.log" || fail "A10: the outage end was not logged: $(tail -n2 "$ROOT/logs/network-heal.log")"
[[ ! -e "$ROOT/logs/.paperclip-net-heal.state" ]] || fail "A10: state was not cleared"
echo "PASS: A10 the network coming back is logged and the state cleared"

# A11: an address without a default route still counts as broken.
set_net yes no 1
reset_calls
heal 10000
heal 10300
grep -qx 'nmcli --wait 60 device connect eth0' <<<"$(calls)" || fail "A11: an address without a default route was treated as healthy: $(calls)"
set_net yes yes 1
heal 10360
# A12: unknown interface: nothing.
reset_calls
heal 10100 PAPERCLIP_NET_IFACE=eth9
[[ -z "$(calls)" ]] || fail "A12: acted on a missing interface: $(calls)"
grep -q 'eth9 does not exist' <<<"$HEAL_OUT" || fail "A12: no message for a missing interface: $HEAL_OUT"
echo "PASS: A11-A12 a missing default route counts as down; a missing interface is left alone"

# A13: no saved NetworkManager profile for the port: never nmcli connect
# (that would create a new permanent profile); the link bounce still runs.
echo no >"$STUB_DIR/nm-profile"
rm -f "$ROOT/logs/.paperclip-net-heal.state"
set_net no no 1
reset_calls
heal 20000
heal 20300
heal 20600
grep -q '^nmcli' <<<"$(calls)" && fail "A13: ran nmcli without a saved profile: $(calls)"
[[ "$(calls)" == $'ip link set dev eth0 down\nip link set dev eth0 up' ]] || fail "A13: expected only the ip link bounce: $(calls)"
grep -q 'no saved profile for eth0' "$ROOT/logs/network-heal.log" || fail "A13: the skip was not logged"
echo yes >"$STUB_DIR/nm-profile"
set_net yes yes 1
heal 20700
echo "PASS: A13 without a saved NetworkManager profile, nmcli connect is never called (no new profile), the link bounce still runs"

# A14: no flock (cannot tell whether an update runs): the reboot step stands back.
rm -f "$ROOT/logs/.paperclip-net-heal.state" "$ROOT/logs/.paperclip-net-heal.last-reboot"
: >"$STUB_LOCK_FILE"
set_net no no 1
reset_calls
for t in 30000 30300 30600 30900 31200 31500 31800 32100; do
  heal "$t" PAPERCLIP_NET_HEAL_REBOOT=1 PAPERCLIP_NET_HEAL_REBOOT_AFTER=1800 PAPERCLIP_FLOCK_CMD=flock-not-installed
done
grep -q reboot <<<"$(calls)" && fail "A14: rebooted without flock (could not check for an update): $(calls)"
grep -q 'Not rebooting during an update' "$ROOT/logs/network-heal.log" || fail "A14: the fail-closed refusal was not logged"
set_net yes yes 1
heal 32200
echo "PASS: A14 without flock the reboot step fails closed (treated as an update running)"

# A15/A16: a missing or failing ip is "cannot tell", not "no address": no
# action at all, state unchanged, non-zero exit (so OnFailure= alerts). Carrier
# is 1 and the outage is long past the grace period plus 3 step intervals.
rm -f "$ROOT/logs/.paperclip-net-heal.state" "$ROOT/logs/.paperclip-net-heal.last-reboot"
set_net no no 1
reset_calls
heal 40000
heal 40300
heal 40600
heal 40900
state_before="$(cat "$ROOT/logs/.paperclip-net-heal.state")"
reset_calls
no_action() {
  local label="$1"
  [[ "$(calls)" != *nmcli* ]] || fail "$label: ran nmcli: $(calls)"
  [[ "$(calls)" != *"ip link"* ]] || fail "$label: ran ip link: $(calls)"
  [[ "$(calls)" != *systemctl* ]] || fail "$label: restarted NetworkManager or rebooted: $(calls)"
  [[ -z "$(calls)" ]] || fail "$label: acted: $(calls)"
  [[ "$(cat "$ROOT/logs/.paperclip-net-heal.state")" == "$state_before" ]] || fail "$label: outage state changed"
}
# A15: ip is not installed.
for t in 41200 41500 41800 42100; do
  HEAL_WANT_RC=1 heal "$t" PAPERCLIP_IP_CMD=ip-not-installed
  grep -q 'ip-not-installed is not installed' <<<"$HEAL_OUT" || fail "A15: no reason on stderr: $HEAL_OUT"
done
no_action A15
echo "PASS: A15 without ip: exit 1, no nmcli/ip link/NetworkManager restart, state unchanged"
# A16: ip exists but exits 1.
echo 1 >"$STUB_DIR/ip-rc"
for t in 42400 42700 43000 43300; do
  HEAL_WANT_RC=1 heal "$t"
  grep -q "exited 1; cannot tell" <<<"$HEAL_OUT" || fail "A16: no reason in the output: $HEAL_OUT"
done
no_action A16
grep -q "cannot tell whether eth0 has" "$ROOT/logs/network-heal.log" || fail "A16: the failure was not written to the heal log"
rm -f "$STUB_DIR/ip-rc"
# the same link with a working ip still heals (the fix did not turn healing off)
heal 43600
grep -qx 'nmcli --wait 60 device connect eth0' <<<"$(calls)" || fail "A16: healing did not resume once ip worked: $(calls)"
set_net yes yes 1
heal 43700
echo "PASS: A16 ip exits 1: exit 1, no action, state unchanged, healing resumes once ip works"

# --- B. paperclip-netwatch.sh ------------------------------------------------
# watch [VAR=value...]: one netwatch run; sets WATCH_RC and WATCH_OUT.
# shellcheck disable=SC2016 # the inner bash expands "$0", not this one
watch() {
  set +e
  WATCH_OUT="$(env PORT=3101 PAPERCLIP_NATIVE_ROOT="$ROOT" "$@" \
    bash -c 'stubbed "$0"' "$SCRIPTS_DIR/paperclip-netwatch.sh" 2>&1)"
  WATCH_RC=$?
  set -e
}
set_path() { set_net "$1" "$2" 1; echo "$3" >"$STUB_DIR/lan-health"; echo "$4" >"$STUB_DIR/dns"; echo "$5" >"$STUB_DIR/https"; }
set_path yes yes up up up
watch
[[ "$WATCH_RC" -eq 0 ]] || fail "B1: a healthy path failed: $WATCH_OUT"
grep -q 'http://192.168.0.163:3101/api/health' "$STUB_DIR/curl.log" || fail "B1: LAN health was not probed on the LAN address"
echo "PASS: B1 healthy path passes (LAN health asked on the LAN address)"
for case_ in "no no up up up:no IPv4 address" "yes no up up up:no default route" "yes yes down up up:LAN address" \
    "yes yes up down up:DNS cannot resolve" "yes yes up up down:no HTTPS answer"; do
  # shellcheck disable=SC2086 # split on purpose
  set_path ${case_%%:*}
  watch
  [[ "$WATCH_RC" -eq 1 ]] || fail "B2: expected exit 1 for '${case_#*:}', got $WATCH_RC: $WATCH_OUT"
  grep -q "${case_#*:}" <<<"$WATCH_OUT" || fail "B2: the failure did not say '${case_#*:}': $WATCH_OUT"
done
# A broken ip tool alerts as "tool broken", not as "no IPv4 address".
set_path yes yes up up up
echo 1 >"$STUB_DIR/ip-rc"
watch
rm -f "$STUB_DIR/ip-rc"
[[ "$WATCH_RC" -eq 1 ]] || fail "B2: a failing ip did not alert (exit $WATCH_RC): $WATCH_OUT"
grep -q 'ip tool is broken or missing' <<<"$WATCH_OUT" || fail "B2: a failing ip was not reported as a broken tool: $WATCH_OUT"
grep -q 'has no IPv4 address' <<<"$WATCH_OUT" && fail "B2: a failing ip was reported as no address: $WATCH_OUT"
grep -q 'network check failed twice' "$ROOT/logs/network-watch.log" || fail "B2: failures were not written to network-watch.log"
echo "PASS: B2 no address / no route / no LAN health / no DNS / no internet each fail with a clear reason"
set_path yes yes up blip up
watch
[[ "$WATCH_RC" -eq 0 ]] || fail "B3: a one-off DNS blip alerted: $WATCH_OUT"
set_path yes yes up up down
watch PAPERCLIP_NETWATCH_HTTPS_URL=
[[ "$WATCH_RC" -eq 0 ]] || fail "B3: an empty PAPERCLIP_NETWATCH_HTTPS_URL did not skip the HTTPS check: $WATCH_OUT"
echo "PASS: B3 a single blip passes on the retry; the HTTPS check can be turned off"

# --- C. paperclip-quiet-restart.sh -------------------------------------------
CG="$WORKDIR/cgroup/system.slice/paperclip-native.service"
PROC="$WORKDIR/proc"
mkdir -p "$CG" "$PROC"
fake_proc() { # fake_proc <pid> <comm> [exe]
  mkdir -p "$PROC/$1"
  echo "$2" >"$PROC/$1/comm"
  [[ -n "${3:-}" ]] && ln -sfn "$3" "$PROC/$1/exe"
  return 0
}
fake_proc 100 MainThread /opt/node
fake_proc 200 postgres "/x/node_modules/@embedded-postgres/linux-x64/native/bin/postgres"
fake_proc 300 claude /opt/claude
echo 100 >"$STUB_DIR/mainpid"
echo 1000000 >"$STUB_DIR/started-us"
echo "100000.00 1.00" >"$WORKDIR/uptime"
echo up >"$STUB_DIR/health"
set_mem() { # set_mem <anon-MB> <swap-MB> <host-swap-used-MB of 5000>
  printf 'anon %s\nfile 999999999\n' $(($1 * 1024 * 1024)) >"$CG/memory.stat"
  echo $(($2 * 1024 * 1024)) >"$CG/memory.swap.current"
  printf 'MemTotal: 16000000 kB\nSwapTotal: %s kB\nSwapFree: %s kB\n' $((5000 * 1024)) $(((5000 - $3) * 1024)) >"$WORKDIR/meminfo"
}
# shellcheck disable=SC2016 # the inner bash expands "$0", not this one
quiet() {
  set +e
  QR_OUT="$(env PORT=3101 PAPERCLIP_NATIVE_ROOT="$ROOT" PAPERCLIP_CGROUP_ROOT="$WORKDIR/cgroup" PAPERCLIP_PROC_ROOT="$PROC" \
    PAPERCLIP_MEMINFO_FILE="$WORKDIR/meminfo" PAPERCLIP_UPTIME_FILE="$WORKDIR/uptime" \
    PAPERCLIP_QUIET_RESTART_POLL=60 PAPERCLIP_QUIET_RESTART_WAIT=300 PAPERCLIP_QUIET_RESTART_HEALTH_DELAY=0 "$@" \
    bash -c 'stubbed "$0"' "$SCRIPTS_DIR/paperclip-quiet-restart.sh" 2>&1)"
  QR_RC=$?
  set -e
}
restarts() { grep -c '^systemctl restart paperclip-native.service$' "$STUB_DIR/calls.log" || true; }

printf '100\n200\n' >"$CG/cgroup.procs"
set_mem 2000 0 0
reset_calls
quiet
[[ "$QR_RC" -eq 0 && "$(restarts)" -eq 0 ]] || fail "C1: restarted a small, young server (rc=$QR_RC): $QR_OUT"
grep -q 'Not needed' <<<"$QR_OUT" || fail "C1: no 'Not needed' line: $QR_OUT"
echo "PASS: C1 a server under every limit is not restarted"

for case_ in "5000 2000 0:memory and swap are 7000MB" "1000 0 3000:host swap is 60% used"; do
  # shellcheck disable=SC2086 # split on purpose
  set_mem ${case_%%:*}
  reset_calls
  quiet
  [[ "$QR_RC" -eq 0 && "$(restarts)" -eq 1 ]] || fail "C2: expected one restart for '${case_#*:}' (rc=$QR_RC): $QR_OUT"
  grep -q "${case_#*:}" "$ROOT/logs/quiet-restart.log" || fail "C2: the reason '${case_#*:}' was not logged"
  grep -qx 'restart: lock held' "$STUB_DIR/calls.log" || fail "C2: the restart ran without holding the update lock"
done
set_mem 1000 0 0
echo "$((4 * 86400 + 100)).00 1.00" >"$WORKDIR/uptime"
reset_calls
quiet
[[ "$(restarts)" -eq 1 ]] || fail "C2: a server up 4 days was not restarted: $QR_OUT"
grep -q 'run for 4 days' "$ROOT/logs/quiet-restart.log" || fail "C2: the uptime reason was not logged"
echo "100000.00 1.00" >"$WORKDIR/uptime"
echo "PASS: C2 memory, host swap or uptime over the limit restarts an idle server, under the update lock"

set_mem 7000 0 0
printf '100\n200\n300\n' >"$CG/cgroup.procs"
reset_calls
quiet
[[ "$QR_RC" -eq 0 && "$(restarts)" -eq 0 ]] || fail "C3: restarted while an agent run was busy (rc=$QR_RC): $QR_OUT"
grep -q 'Skipped: .*claude(300)' "$ROOT/logs/quiet-restart.log" || fail "C3: the skip did not name the busy agent run"
echo "PASS: C3 an agent run that stays busy past the wait means no restart tonight"

# C4: the agent run ends during the wait: restart after it.
cat >"$STUB_DIR/on-sleep" <<EOF
#!/usr/bin/env bash
printf '100\n200\n' >"$CG/cgroup.procs"
EOF
chmod +x "$STUB_DIR/on-sleep"
printf '100\n200\n300\n' >"$CG/cgroup.procs"
reset_calls
quiet
rm -f "$STUB_DIR/on-sleep"
[[ "$QR_RC" -eq 0 && "$(restarts)" -eq 1 ]] || fail "C4: no restart after the agent run finished (rc=$QR_RC): $QR_OUT"
echo "PASS: C4 waits for the agent run to finish, then restarts"

# C5: an update holds the lock: no restart.
hold_update_lock
reset_calls
quiet
release_update_lock
[[ "$QR_RC" -eq 0 && "$(restarts)" -eq 0 ]] || fail "C5: restarted during an update (rc=$QR_RC): $QR_OUT"
echo "PASS: C5 no restart while an update holds its lock"

# C6: the server does not come back: exit 1 so the alert fires.
echo down >"$STUB_DIR/health"
quiet PAPERCLIP_QUIET_RESTART_HEALTH_ATTEMPTS=2
echo up >"$STUB_DIR/health"
[[ "$QR_RC" -eq 1 ]] || fail "C6: a server that did not come back exited $QR_RC: $QR_OUT"
echo "PASS: C6 a restart that does not bring the server back exits 1 (alert)"

# C7: no flock: never restart without the update lock; exit 1 (alert).
reset_calls
quiet PAPERCLIP_FLOCK_CMD=flock-not-installed
[[ "$QR_RC" -eq 1 && "$(restarts)" -eq 0 ]] || fail "C7: without flock: rc=$QR_RC restarts=$(restarts): $QR_OUT"
grep -q 'flock-not-installed is not installed' "$ROOT/logs/quiet-restart.log" || fail "C7: the refusal was not logged"
echo "PASS: C7 without flock it never restarts (fails closed, exit 1 for the alert)"

# --- D. install_safety_net installs and enables the new timers once ----------
INSTALL_ROOT="$WORKDIR/install root"
mkdir -p "$INSTALL_ROOT/logs" "$INSTALL_ROOT/recovery/scripts"
# shellcheck disable=SC2016 # the inner bash expands these, not this one
install_once() {
  set +e
  INST_OUT="$(PAPERCLIP_SYSTEMD_DIR="$WORKDIR/etc-systemd" stubbed bash -c '
    source "$1"; DRY_RUN=0
    install_safety_net "$2" "$3" "$4" "$5"
  ' x "$NATIVE_DIR/lib/common.sh" "$ZIMAOS_DIR" "$INSTALL_ROOT" "$WORKDIR" "$INSTALL_ROOT/recovery" 2>&1)"
  INST_RC=$?
  set -e
  [[ "$INST_RC" -eq 0 ]] || fail "D: install_safety_net failed (rc=$INST_RC): $INST_OUT"
}
reset_calls
install_once
for f in paperclip-net-heal.sh paperclip-netwatch.sh paperclip-quiet-restart.sh; do
  [[ -x "$INSTALL_ROOT/recovery/scripts/$f" ]] || fail "D: $f was not installed executable. $INST_OUT"
done
for f in "${SAFETY_NET_TIMERS[@]}"; do
  [[ -f "$WORKDIR/etc-systemd/$f" && -f "$WORKDIR/etc-systemd/${f%.timer}.service" ]] || fail "D: $f or its service was not installed"
  grep -qx "systemctl enable --now $f" "$STUB_DIR/calls.log" || fail "D: $f was not enabled on its first install: $(calls)"
done
grep -qF "ExecStart=\"$INSTALL_ROOT/recovery/scripts/paperclip-net-heal.sh\"" "$WORKDIR/etc-systemd/paperclip-native-net-heal.service" \
  || fail "D: the net-heal unit was not rendered for this root: $(cat "$WORKDIR/etc-systemd/paperclip-native-net-heal.service")"
grep -q 'restart paperclip-native' "$STUB_DIR/calls.log" && fail "D: install_safety_net restarted the server"
reset_calls
install_once
grep -q 'enable' "$STUB_DIR/calls.log" && fail "D: a second install enabled a timer again (a person may have disabled it): $(calls)"
echo "PASS: D install_safety_net installs the new scripts and units, enables each new timer only on its first install"

# --- E. The new units pass systemd-analyze verify, rendered for a root with a space
command -v systemd-analyze >/dev/null 2>&1 || fail "E: systemd-analyze is not installed"
FR="$WORKDIR/fr"
root="$UNIT_DEFAULT_ROOT"
mkdir -p "$FR/etc/systemd/system" "$FR/usr/lib" "$FR$root/env" "$FR$root/recovery/scripts" "$FR/usr/local/lib/paperclip/scripts"
cp -rL /usr/lib/systemd "$FR/usr/lib/systemd" 2>/dev/null || true
for f in "${SAFETY_NET_UNITS[@]}"; do
  [[ "$f" == */* ]] && continue
  render_unit_file "$ZIMAOS_DIR/systemd/$f" "$FR/etc/systemd/system/$f" "$root" "$UNIT_DEFAULT_MOUNT_PATH" "$root/recovery"
done
for f in "${SAFETY_NET_SCRIPTS[@]}"; do printf '#!/bin/sh\n' >"$FR$root/recovery/scripts/$f"; chmod +x "$FR$root/recovery/scripts/$f"; done
: >"$FR$root/env/paperclip-native.env"
: >"$FR$root/env/telegram.env"
cp "$ZIMAOS_DIR/systemd/paperclip-native-alert@.service" "$ZIMAOS_DIR/systemd/paperclip-native.service" "$FR/etc/systemd/system/"
printf '#!/bin/sh\n' >"$FR/usr/local/lib/paperclip/scripts/telegram-alert.sh"
chmod +x "$FR/usr/local/lib/paperclip/scripts/telegram-alert.sh"
for unit in paperclip-native-net-heal.service paperclip-native-netwatch.service paperclip-native-quiet-restart.service \
    "${SAFETY_NET_TIMERS[@]}"; do
  out="$(systemd-analyze verify --root="$FR" "$unit" 2>&1 | grep -v 'is not a symlink, ignoring' || true)"
  systemd-analyze verify --root="$FR" "$unit" >/dev/null 2>&1 || fail "E: systemd-analyze verify rejected $unit: $out"
done
echo "PASS: E the new services and timers pass systemd-analyze verify, rendered for '$root'"

echo "All network safety net tests passed."
