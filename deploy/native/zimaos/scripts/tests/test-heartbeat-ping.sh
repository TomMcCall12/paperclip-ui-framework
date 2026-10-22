#!/usr/bin/env bash
# Offline test for paperclip-heartbeat.sh (TOM-721), no root and no network:
#   A. Healthy Paperclip and a fresh stall alarm, URL set: exactly one ping
#      to the URL, exit 0 (with jq and with the python3 fallback).
#   B. Stale alarm (14 minutes), URL set: no success ping, one /fail ping with
#      the reason, exit 0. The same stale answer with no URL: exit 1 (host
#      alert), once an hour.
#   C. No URL and healthy: no ping, exit 0, no error; logs once a day.
#   D. The other pass and fail cases of the freshness rule: alarm off,
#      just started, last sweep failed, never swept, no stallSentinel, server
#      not answering, status not ok, neither jq nor python3.
#   E. A ping that cannot be sent and a URL that is not a URL exit 1, once an
#      hour.
#   F. The URL never appears in the script's output, in curl's arguments or
#      in this test's output.
#   G. install_safety_net installs the script, helper and both units and
#      enables the timer on the first install only; the units pass
#      systemd-analyze verify.
# curl is a stub that answers /api/health from a file and records pings.
#
# Usage: test-heartbeat-ping.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIMAOS_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
NATIVE_DIR="$(cd "$ZIMAOS_DIR/.." && pwd)"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(make_exec_capable_tempdir paperclip-heartbeat-test "$NATIVE_DIR")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

HB="$SCRIPTS_DIR/paperclip-heartbeat.sh"
BIN="$WORKDIR/bin"
STUB_DIR="$WORKDIR/stub"
STATE="$WORKDIR/state"
mkdir -p "$BIN" "$STUB_DIR" "$STATE"
export STUB_DIR

# A made-up URL with a marker in it, so any leak is easy to grep for.
SECRET_URL="https://hc-ping.example/SECRET-MARKER-3f9a1c5e"
NOW=1792000000

# curl stub. /api/health: prints health.json, exits health-rc. A call with
# -K - is a ping: the curl config arrives on standard input (the URL is not an
# argument). The config goes to ping-config.log (private), only its kind to
# pings.log, the arguments to argv.log; exits ping-rc.
cat >"$BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >>"$STUB_DIR/argv.log"
is_ping=0
for a in "$@"; do [[ "$a" == "-K" ]] && is_ping=1; done
if [[ "$is_ping" -eq 1 ]]; then
  cfg="$(cat)"
  printf '%s\n' "$cfg" >>"$STUB_DIR/ping-config.log"
  data=""
  prev=""
  for a in "$@"; do [[ "$prev" == "--data-raw" ]] && data="$a"; prev="$a"; done
  case "$cfg" in
    *'/fail"'*) echo "fail: $data" >>"$STUB_DIR/pings.log" ;;
    *) echo "ok" >>"$STUB_DIR/pings.log" ;;
  esac
  exit "$(cat "$STUB_DIR/ping-rc" 2>/dev/null || echo 0)"
fi
for a in "$@"; do
  if [[ "$a" == http://127.0.0.1:* ]]; then
    rc="$(cat "$STUB_DIR/health-rc" 2>/dev/null || echo 0)"
    [[ "$rc" -eq 0 ]] && cat "$STUB_DIR/health.json"
    exit "$rc"
  fi
done
exit 99
EOF
chmod +x "$BIN/curl"

iso() { date -u -d "@$1" '+%Y-%m-%dT%H:%M:%S.000Z'; }

# health <sentinel-json-or-"none"> [status]
health() {
  local s="$1" status="${2:-ok}"
  if [[ "$s" == "none" ]]; then
    printf '{"status":"%s","version":"1.2.3"}' "$status" >"$STUB_DIR/health.json"
  else
    printf '{"status":"%s","version":"1.2.3","stallSentinel":%s}' "$status" "$s" >"$STUB_DIR/health.json"
  fi
}
sentinel() { # sentinel <mode> <started-ago-s> <last-ago-s|null> <ok:true|false>
  local last="null"
  [[ "$3" != "null" ]] && last="\"$(iso $((NOW - $3)))\""
  printf '{"mode":"%s","effectiveMode":"%s","startedAt":"%s","lastSweepAt":%s,"lastSweepOk":%s}' \
    "$1" "$1" "$(iso $((NOW - $2)))" "$last" "$4"
}

reset() {
  rm -f "$STUB_DIR"/*.log "$STUB_DIR/health-rc" "$STUB_DIR/ping-rc"
  rm -rf "$STATE"
  mkdir -p "$STATE"
  OUT=""
  RC=0
}
pings() { if [[ -f "$STUB_DIR/pings.log" ]]; then cat "$STUB_DIR/pings.log"; fi; }
ping_count() { if [[ -f "$STUB_DIR/pings.log" ]]; then wc -l <"$STUB_DIR/pings.log" | tr -d ' '; else echo 0; fi; }

# run_hb <extra-env-assignment>...: runs the script, URL taken from $URL_ENV.
# Output goes to $OUT (and to $ALL_OUT, to check for leaks at the end).
ALL_OUT="$WORKDIR/all-output.log"
: >"$ALL_OUT"
URL_ENV="$SECRET_URL"
PARSER="jq"
run_hb() {
  set +e
  OUT="$(env -u BASH_ENV PATH="$BIN:$PATH" PORT=3101 STATE_DIRECTORY="$STATE" \
    PAPERCLIP_HEARTBEAT_NOW="$NOW" PAPERCLIP_HEARTBEAT_PARSER="$PARSER" \
    PAPERCLIP_HEALTHCHECKS_PING_URL="$URL_ENV" "$@" "$HB" 2>&1)"
  RC=$?
  set -e
  printf '%s\n' "$OUT" >>"$ALL_OUT"
}

# --- A. healthy, URL set: one ping -----------------------------------------------
for PARSER in jq python3; do
  reset
  health "$(sentinel on 86400 120 true)"
  run_hb
  [[ "$RC" -eq 0 ]] || fail "A($PARSER): healthy run exited $RC: $OUT"
  [[ "$(ping_count)" -eq 1 && "$(pings)" == "ok" ]] || fail "A($PARSER): expected exactly one plain ping, got: $(pings)"
  grep -qF "url = \"$SECRET_URL\"" "$STUB_DIR/ping-config.log" || fail "A($PARSER): the ping did not go to the configured URL"
  grep -q 'ping sent' <<<"$OUT" || fail "A($PARSER): no 'ping sent' log line: $OUT"
  grep -q -- '--max-time' "$STUB_DIR/argv.log" || fail "A($PARSER): the ping has no timeout"
  grep -q -- '--retry 3' "$STUB_DIR/argv.log" || fail "A($PARSER): the ping has no retries: $(cat "$STUB_DIR/argv.log")"
  echo "PASS: A healthy -> exactly one ping ($PARSER)"
done

# A trailing slash and a trailing carriage return (from an edited env file) are fine.
PARSER=jq
reset
health "$(sentinel on 86400 120 true)"
URL_ENV="$SECRET_URL/"$'\r'
run_hb
[[ "$RC" -eq 0 && "$(ping_count)" -eq 1 ]] || fail "A2: a URL with a trailing slash and CR was not pinged once (rc=$RC): $OUT"
URL_ENV="$SECRET_URL"
echo "PASS: A2 a trailing slash or carriage return in the URL is tolerated"

# --- B. stale alarm: no success ping, /fail, check fails -----------------------
for PARSER in jq python3; do
  reset
  health "$(sentinel on 86400 840 true)"
  run_hb
  [[ "$RC" -eq 0 ]] || fail "B($PARSER): stale with a URL should report by /fail and exit 0, exited $RC: $OUT"
  [[ "$(ping_count)" -eq 1 && "$(pings)" == "fail: sentinel stale 14 min" ]] || fail "B($PARSER): expected one /fail ping with the reason, got: $(pings)"
  grep -qF "url = \"$SECRET_URL/fail\"" "$STUB_DIR/ping-config.log" || fail "B($PARSER): the /fail ping did not go to <URL>/fail"
  echo "PASS: B stale alarm with a URL -> no success ping, one /fail ping 'sentinel stale 14 min' ($PARSER)"

  reset
  health "$(sentinel on 86400 840 true)"
  URL_ENV=""
  run_hb
  [[ "$RC" -eq 1 ]] || fail "B2($PARSER): stale with no URL should exit 1 (host alert), exited $RC: $OUT"
  [[ "$(ping_count)" -eq 0 ]] || fail "B2($PARSER): stale with no URL pinged: $(pings)"
  grep -q 'sentinel stale 14 min' <<<"$OUT" || fail "B2($PARSER): reason missing from the log: $OUT"
  run_hb
  [[ "$RC" -eq 0 ]] || fail "B2($PARSER): a second failure within the hour should stay quiet (exit 0), exited $RC: $OUT"
  NOW=$((NOW + 3601))
  health "$(sentinel on 86400 840 true)"
  run_hb
  [[ "$RC" -eq 1 ]] || fail "B2($PARSER): after an hour the failure should alert again, exited $RC: $OUT"
  NOW=$((NOW - 3601))
  URL_ENV="$SECRET_URL"
  echo "PASS: B2 stale alarm with no URL -> no ping, exit 1 once an hour ($PARSER)"
done

# A recovered check clears the hour stamp: the next failure alerts at once.
PARSER=jq
reset
URL_ENV=""
health "$(sentinel on 86400 840 true)"; run_hb
[[ "$RC" -eq 1 ]] || fail "B3: first failure exited $RC"
health "$(sentinel on 86400 60 true)"; run_hb
[[ "$RC" -eq 0 ]] || fail "B3: healthy run exited $RC: $OUT"
health "$(sentinel on 86400 840 true)"; run_hb
[[ "$RC" -eq 1 ]] || fail "B3: a new failure after recovery should alert at once, exited $RC: $OUT"
URL_ENV="$SECRET_URL"
echo "PASS: B3 recovery clears the hourly stamp"

# --- C. no URL, healthy: no-op ---------------------------------------------------
for PARSER in jq python3; do
  reset
  URL_ENV=""
  health "$(sentinel on 86400 120 true)"
  run_hb
  [[ "$RC" -eq 0 ]] || fail "C($PARSER): no URL and healthy exited $RC: $OUT"
  [[ "$(ping_count)" -eq 0 ]] || fail "C($PARSER): pinged with no URL: $(pings)"
  grep -q 'ERROR' <<<"$OUT" && fail "C($PARSER): logged an error with no URL: $OUT"
  grep -q 'Heartbeat URL not configured' <<<"$OUT" || fail "C($PARSER): did not log that no URL is configured: $OUT"
  run_hb
  [[ "$RC" -eq 0 && -z "$OUT" ]] || fail "C($PARSER): second run should be silent (once a day), rc=$RC out: $OUT"
  grep -q -- '-K' "$STUB_DIR/argv.log" && fail "C($PARSER): curl was asked to ping with no URL"
  URL_ENV="$SECRET_URL"
  echo "PASS: C no URL -> no ping, exit 0, no error, logs once ($PARSER)"
done

# --- D. the freshness rule ---------------------------------------------------------
PARSER=jq
expect() { # expect <label> <pass|fail> <fail-reason-substring>
  local label="$1" want="$2" reason="${3:-}"
  for PARSER in jq python3; do
    reset
    run_hb
    if [[ "$want" == pass ]]; then
      [[ "$RC" -eq 0 && "$(pings)" == "ok" ]] || fail "D $label ($PARSER): expected a plain ping, rc=$RC pings='$(pings)' out: $OUT"
    else
      [[ "$RC" -eq 0 && "$(ping_count)" -eq 1 && "$(pings)" == "fail: "*"$reason"* ]] || fail "D $label ($PARSER): expected one /fail ping containing '$reason', rc=$RC pings='$(pings)' out: $OUT"
    fi
  done
  echo "PASS: D $label"
}
health "$(sentinel off 86400 null true)";             expect "alarm switched off -> pass" pass
health "$(sentinel on 120 null true)";                expect "just started, not swept yet -> pass" pass
health "$(sentinel on 86400 599 true)";               expect "swept 599 s ago -> pass" pass
health "$(sentinel on 86400 601 true)";               expect "swept 601 s ago -> fail" fail "sentinel stale 10 min"
health "$(sentinel on 86400 60 false)";               expect "last sweep failed -> fail" fail "last sentinel sweep failed"
health "$(sentinel on 86400 null true)";              expect "never swept, started long ago -> fail" fail "has not swept"
health none;                                          expect "no stallSentinel field -> fail" fail "no stallSentinel"
health "$(sentinel on 86400 60 true)" degraded;       expect "status not ok -> fail" fail "status is not ok"

for PARSER in jq python3; do
  reset
  echo 7 >"$STUB_DIR/health-rc"
  run_hb
  [[ "$RC" -eq 0 && "$(pings)" == "fail: Paperclip did not answer /api/health (curl exit 7)" ]] || fail "D server down ($PARSER): rc=$RC pings='$(pings)' out: $OUT"
done
echo "PASS: D Paperclip not answering -> /fail ping"

reset
PARSER=none
health "$(sentinel on 86400 60 true)"
run_hb
[[ "$RC" -eq 0 && "$(pings)" == "fail: neither jq nor python3 is installed"* ]] || fail "D no parser: rc=$RC pings='$(pings)' out: $OUT"
PARSER=jq
echo "PASS: D neither jq nor python3 -> fails closed (/fail ping), never a false green"

reset
printf 'not json at all' >"$STUB_DIR/health.json"
for PARSER in jq python3; do
  reset; printf 'not json at all' >"$STUB_DIR/health.json"
  run_hb
  [[ "$RC" -eq 0 && "$(pings)" == "fail: /api/health answer could not be read" ]] || fail "D garbage ($PARSER): rc=$RC pings='$(pings)' out: $OUT"
done
echo "PASS: D a health answer that is not JSON -> fail"

# --- E. ping problems -----------------------------------------------------------------
PARSER=jq
reset
health "$(sentinel on 86400 60 true)"
echo 22 >"$STUB_DIR/ping-rc"
run_hb
[[ "$RC" -eq 1 ]] || fail "E: a ping that failed should exit 1, exited $RC: $OUT"
grep -q 'ping failed (curl exit 22)' <<<"$OUT" || fail "E: log should say 'ping failed (curl exit 22)': $OUT"
run_hb
[[ "$RC" -eq 0 ]] || fail "E: a second ping failure within the hour should stay quiet, exited $RC: $OUT"
echo "PASS: E a ping that cannot be sent -> exit 1 once an hour"

for bad in 'ftp://hc-ping.example/x' 'not a url' 'https://hc-ping.example/"x'; do
  reset
  health "$(sentinel on 86400 60 true)"
  URL_ENV="$bad"
  run_hb
  [[ "$RC" -eq 1 && "$(ping_count)" -eq 0 ]] || fail "E: bad URL '$bad' should exit 1 with no ping (rc=$RC): $OUT"
  grep -q 'not an http(s) URL' <<<"$OUT" || fail "E: bad URL not explained: $OUT"
done
URL_ENV="$SECRET_URL"
echo "PASS: E a value that is not an http(s) URL -> exit 1, no ping, value not shown"

# --- F. no leak -----------------------------------------------------------------------
if grep -q 'SECRET-MARKER' "$ALL_OUT" "$STUB_DIR"/argv.log 2>/dev/null; then
  fail "F: the ping URL appeared in the script output or in curl's arguments"
fi
grep -q 'SECRET-MARKER' "$STUB_DIR/ping-config.log" 2>/dev/null || true
echo "PASS: F the URL is in none of the script output or curl arguments (it only goes to curl on standard input)"

# --- G. installed by install_safety_net; units verify -------------------------------------
INSTALL_ROOT="$WORKDIR/install root"
mkdir -p "$INSTALL_ROOT/logs" "$INSTALL_ROOT/recovery/scripts"
cat >"$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >>"$STUB_DIR/sysctl.log"
exit 0
EOF
chmod +x "$BIN/systemctl"
# shellcheck disable=SC2016 # the inner bash expands these, not this one
install_once() {
  set +e
  INST_OUT="$(env -u BASH_ENV PATH="$BIN:$PATH" PAPERCLIP_SYSTEMD_DIR="$WORKDIR/etc-systemd" bash -c '
    source "$1"; DRY_RUN=0
    install_safety_net "$2" "$3" "$4" "$5"
  ' x "$NATIVE_DIR/lib/common.sh" "$ZIMAOS_DIR" "$INSTALL_ROOT" "$WORKDIR" "$INSTALL_ROOT/recovery" 2>&1)"
  INST_RC=$?
  set -e
  [[ "$INST_RC" -eq 0 ]] || fail "G: install_safety_net failed (rc=$INST_RC): $INST_OUT"
}
rm -f "$STUB_DIR/sysctl.log"
install_once
for f in paperclip-heartbeat.sh paperclip-heartbeat-check.py; do
  [[ -x "$INSTALL_ROOT/recovery/scripts/$f" ]] || fail "G: $f was not installed executable. $INST_OUT"
done
for f in paperclip-native-heartbeat.service paperclip-native-heartbeat.timer; do
  [[ -f "$WORKDIR/etc-systemd/$f" ]] || fail "G: $f was not installed"
done
grep -qx 'systemctl enable paperclip-native-heartbeat.timer' "$STUB_DIR/sysctl.log" || fail "G: the heartbeat timer was not enabled (without --now) on its first install: $(cat "$STUB_DIR/sysctl.log")"
grep -qF "ExecStart=\"$INSTALL_ROOT/recovery/scripts/paperclip-heartbeat.sh\"" "$WORKDIR/etc-systemd/paperclip-native-heartbeat.service" \
  || fail "G: the heartbeat unit was not rendered for this root: $(cat "$WORKDIR/etc-systemd/paperclip-native-heartbeat.service")"
grep -q 'heartbeat.timer.*--now\|--now.*heartbeat.timer' "$STUB_DIR/sysctl.log" && fail "G: the heartbeat timer was started on first install (TOM-782)"
grep -q 'restart paperclip-native' "$STUB_DIR/sysctl.log" && fail "G: install_safety_net restarted the server"
rm -f "$STUB_DIR/sysctl.log"
install_once
grep -q 'enable' "$STUB_DIR/sysctl.log" && fail "G: a second install enabled the timer again"
echo "PASS: G install_safety_net installs the heartbeat script, helper and units; enables the timer on the first install only"

# The unit never restarts anything and is not wired to the recovery unit.
unit="$ZIMAOS_DIR/systemd/paperclip-native-heartbeat.service"
grep -Eqi 'recover|restart' <(grep -v '^#' "$unit") && fail "G: the heartbeat unit mentions recovery or restart"
grep -qx 'OnFailure=paperclip-native-alert@%n.service' "$unit" || fail "G: the heartbeat unit has no host alert on failure"
grep -qx 'DynamicUser=yes' "$unit" || fail "G: the heartbeat unit does not run as a throwaway user"
echo "PASS: G the heartbeat unit alerts but never recovers or restarts, and runs as a throwaway user"

if command -v systemd-analyze >/dev/null 2>&1; then
  FR="$WORKDIR/fr"
  root="$UNIT_DEFAULT_ROOT"
  mkdir -p "$FR/etc/systemd/system" "$FR/usr/lib" "$FR$root/env" "$FR$root/recovery/scripts" "$FR/usr/local/lib/paperclip/scripts"
  cp -rL /usr/lib/systemd "$FR/usr/lib/systemd" 2>/dev/null || true
  for f in paperclip-native-heartbeat.service paperclip-native-heartbeat.timer; do
    render_unit_file "$ZIMAOS_DIR/systemd/$f" "$FR/etc/systemd/system/$f" "$root" "$UNIT_DEFAULT_MOUNT_PATH" "$root/recovery"
  done
  printf '#!/bin/sh\n' >"$FR$root/recovery/scripts/paperclip-heartbeat.sh"
  chmod +x "$FR$root/recovery/scripts/paperclip-heartbeat.sh"
  : >"$FR$root/env/paperclip-native.env"
  : >"$FR$root/env/telegram.env"
  cp "$ZIMAOS_DIR/systemd/paperclip-native-alert@.service" "$ZIMAOS_DIR/systemd/paperclip-native.service" "$FR/etc/systemd/system/"
  printf '#!/bin/sh\n' >"$FR/usr/local/lib/paperclip/scripts/telegram-alert.sh"
  chmod +x "$FR/usr/local/lib/paperclip/scripts/telegram-alert.sh"
  for unit in paperclip-native-heartbeat.service paperclip-native-heartbeat.timer; do
    out="$(systemd-analyze verify --root="$FR" "$unit" 2>&1 | grep -v 'is not a symlink, ignoring' || true)"
    systemd-analyze verify --root="$FR" "$unit" >/dev/null 2>&1 || fail "G: systemd-analyze verify rejected $unit: $out"
  done
  echo "PASS: G the heartbeat service and timer pass systemd-analyze verify, rendered for '$root'"
else
  echo "SKIP: G systemd-analyze is not installed"
fi

echo "All heartbeat tests passed."
