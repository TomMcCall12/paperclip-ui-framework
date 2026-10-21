#!/usr/bin/env bash
# External heartbeat (dead-man's switch) for Tom's Lab (TOM-721).
# Run every 5 minutes by paperclip-native-heartbeat.timer as a throwaway
# systemd user (DynamicUser). It checks two things:
#   1. Paperclip answers http://127.0.0.1:$PORT/api/health with status "ok";
#   2. the stall alarm swept in the last PAPERCLIP_HEARTBEAT_MAX_AGE seconds
#      (default 600, ten minutes) and that sweep worked, or the alarm is
#      switched off on purpose, or the server has just started.
#
# Both pass and PAPERCLIP_HEALTHCHECKS_PING_URL is set: ping that URL. When
# the pings stop (host frozen, network down, power off, server down or alarm
# stopped) Healthchecks.io tells Tom on Telegram after about 15 minutes. This
# is the one alert that still works when the ZimaBoard itself is the problem.
# A check fails and the URL is set: ping "<URL>/fail" with a short reason, so
# Healthchecks.io alerts at once, then exit 0 (one alert channel, no duplicate
# host alert). A check fails and no URL is set: exit 1, which fires the unit's
# OnFailure= Telegram alert, at most once an hour while the failure lasts.
# Both pass and no URL is set: log it once a day and exit 0. A ping that
# cannot be sent (or a URL that is not an http(s) URL) also exits 1, at most
# once an hour: a check that never gets a ping never alerts, so a wrong URL
# must not stay silent.
#
# It never restarts anything and never prints the URL. The URL reaches curl
# on its standard input (a curl config), not as an argument, so it is also
# not in the process list. Logs say only "ping sent" or "ping failed (curl
# exit N)".
#
# The URL lives in <root>/env/heartbeat.env (root, mode 0600), which systemd
# reads. The script runs as a different user, so agent runs can read neither
# the file nor this script's environment.
#
# Self-contained on purpose (no lib/common.sh): it lives in the recovery
# path outside every release.
#
# Environment (all optional except as noted):
#   PORT                             Paperclip port (from paperclip-native.env).
#   PAPERCLIP_HEALTHCHECKS_PING_URL  The Healthchecks.io ping URL (secret).
#   PAPERCLIP_HEARTBEAT_MAX_AGE      Seconds before the alarm counts as stale (600).
#   PAPERCLIP_HEARTBEAT_ALERT_EVERY  Seconds between host alerts (3600).
#   STATE_DIRECTORY                  Set by systemd; holds the rate-limit stamps.
#   PAPERCLIP_HEARTBEAT_NOW          Test only: the current time in epoch seconds.
#   PAPERCLIP_HEARTBEAT_PARSER       Test only: "jq" or "python3" to force one.
#
# Usage: paperclip-heartbeat.sh [--dry-run]
set -euo pipefail

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3101}"
URL="${PAPERCLIP_HEALTHCHECKS_PING_URL:-}"
MAX_AGE="${PAPERCLIP_HEARTBEAT_MAX_AGE:-600}"
ALERT_EVERY="${PAPERCLIP_HEARTBEAT_ALERT_EVERY:-3600}"
STATE_DIR="${STATE_DIRECTORY:-}"

[[ "$PORT" =~ ^[0-9]+$ ]] || { log "ERROR: PORT must be a whole number"; exit 2; }
[[ "$MAX_AGE" =~ ^[0-9]+$ ]] || { log "ERROR: PAPERCLIP_HEARTBEAT_MAX_AGE must be a whole number"; exit 2; }
[[ "$ALERT_EVERY" =~ ^[0-9]+$ ]] || { log "ERROR: PAPERCLIP_HEARTBEAT_ALERT_EVERY must be a whole number"; exit 2; }

if [[ "${1:-}" == "--dry-run" ]]; then
  log "[dry-run] would check http://127.0.0.1:$PORT/api/health (status ok) and that the stall alarm swept within ${MAX_AGE}s"
  log "[dry-run] both pass and a ping URL is set: ping it; a check fails and a URL is set: ping <URL>/fail; a check fails and no URL is set: exit 1 (host Telegram alert, at most once per ${ALERT_EVERY}s)"
  exit 0
fi

now() { printf '%s' "${PAPERCLIP_HEARTBEAT_NOW:-$(date +%s)}"; }

# stamp_age <name>: seconds since the stamp was written; a huge number when
# there is none.
stamp_age() {
  local f="$STATE_DIR/$1" t
  if [[ -n "$STATE_DIR" && -f "$f" ]] && t="$(<"$f")" && [[ "$t" =~ ^[0-9]+$ ]]; then
    printf '%s' "$(( $(now) - t ))"
  else
    printf '%s' 999999999
  fi
}
stamp_write() {
  if [[ -n "$STATE_DIR" ]]; then printf '%s\n' "$(now)" >"$STATE_DIR/$1" || true; fi
}
stamp_clear() {
  if [[ -n "$STATE_DIR" ]]; then rm -f "$STATE_DIR"/alerted-* || true; fi
}

# alert_exit <name> <message>: log and exit 1 so the host alert fires, but
# only once per ALERT_EVERY seconds for the same failure kind.
alert_exit() {
  local name="$1" msg="$2" age
  age="$(stamp_age "alerted-$name")"
  if [[ "$age" -le "$ALERT_EVERY" ]]; then
    log "$msg (host alert already sent ${age}s ago; staying quiet)"
    exit 0
  fi
  stamp_write "alerted-$name"
  log "ERROR: $msg"
  exit 1
}

# judge <health-json>: prints "ok" or "fail<TAB>reason".
judge() {
  local health="$1" parser="${PAPERCLIP_HEARTBEAT_PARSER:-}" t
  t="$(now)"
  if [[ -z "$parser" ]]; then
    if command -v jq >/dev/null 2>&1; then parser=jq
    elif command -v python3 >/dev/null 2>&1; then parser=python3
    fi
  fi
  case "$parser" in
    jq)
      printf '%s' "$health" | jq -r --argjson now "$t" --argjson max "$MAX_AGE" '
        def ts: .[0:19] + "Z" | fromdateiso8601;  # drops any fraction; no regex (some jq builds lack it)
        .stallSentinel as $s
        | if .status != "ok" then "fail\tPaperclip health status is not ok"
          elif ($s | type) != "object" then "fail\tno stallSentinel in /api/health (older build?)"
          elif $s.mode == "off" then "ok"
          elif $s.lastSweepAt != null then
            ($now - ($s.lastSweepAt | ts)) as $age
            | if $age > $max then "fail\tsentinel stale \($age / 60 | floor) min"
              elif $s.lastSweepOk != true then "fail\tlast sentinel sweep failed"
              else "ok" end
          elif $s.startedAt != null and ($now - ($s.startedAt | ts)) <= $max then "ok"
          else "fail\tsentinel has not swept since start" end' 2>/dev/null \
        || printf 'fail\t/api/health answer could not be read\n' ;;
    python3)
      printf '%s' "$health" | python3 -I "$SCRIPT_DIR/paperclip-heartbeat-check.py" "$t" "$MAX_AGE" ;;
    *)
      printf 'fail\tneither jq nor python3 is installed, so the stall alarm cannot be checked\n' ;;
  esac
}

# ping <suffix> [reason]: ping the URL (plus a suffix such as /fail). The URL
# goes to curl on standard input; curl's own messages are dropped because
# some curl versions name the URL in them. Returns curl's exit code.
ping_url() {
  local suffix="$1" reason="${2:-}" rc=0
  local -a extra=()
  if [[ -n "$reason" ]]; then extra=(--data-raw "$reason"); fi
  printf 'url = "%s%s"\n' "${URL%/}" "$suffix" \
    | curl -fsS --max-time 10 --connect-timeout 5 --retry 3 --retry-delay 5 -o /dev/null "${extra[@]}" -K - 2>/dev/null \
    || rc=$?
  return "$rc"
}

# --- 1. The URL, if there is one ---------------------------------------------
# Strip spaces and a stray carriage return; accept only characters a ping
# URL can hold (no quote, backslash or control character), so it is safe in
# the curl config above. The value is never printed.
URL="${URL//[[:space:]]/}"
if [[ -n "$URL" && ! "$URL" =~ ^https?://[A-Za-z0-9._~:/?#@\!\$\&\'\(\)*+,\;=%-]+$ ]]; then
  alert_exit bad-url "PAPERCLIP_HEALTHCHECKS_PING_URL is not an http(s) URL (the value is not shown); fix <root>/env/heartbeat.env"
fi

# --- 2. The two checks ---------------------------------------------------------
verdict=""
health=""
hrc=0
health="$(curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health" 2>/dev/null)" || hrc=$?
if [[ "$hrc" -ne 0 ]]; then
  verdict="$(printf 'fail\tPaperclip did not answer /api/health (curl exit %s)' "$hrc")"
else
  verdict="$(judge "$health")"
fi

# --- 3. Act on the result -------------------------------------------------------
if [[ "$verdict" == "ok" ]]; then
  if [[ -z "$URL" ]]; then
    if [[ "$(stamp_age no-url-logged)" -gt 86400 ]]; then
      log "Heartbeat URL not configured (PAPERCLIP_HEALTHCHECKS_PING_URL is empty); Paperclip health and the stall alarm are fine, nothing to ping. Logging this once a day."
      stamp_write no-url-logged
    fi
    stamp_clear
    exit 0
  fi
  prc=0
  ping_url "" || prc=$?
  if [[ "$prc" -ne 0 ]]; then
    alert_exit ping-failed "ping failed (curl exit $prc); Healthchecks.io will not hear from this host"
  fi
  stamp_clear
  log "ping sent (Paperclip health and stall alarm fine)"
  exit 0
fi

reason="${verdict#fail$'\t'}"
if [[ -z "$URL" ]]; then
  alert_exit check-failed "heartbeat check failed: $reason (no ping URL is set, so only this host alert reports it)"
fi
prc=0
ping_url /fail "$reason" || prc=$?
if [[ "$prc" -ne 0 ]]; then
  alert_exit ping-failed "heartbeat check failed ($reason) and the /fail ping failed (curl exit $prc)"
fi
log "check failed ($reason); /fail ping sent"
exit 0
