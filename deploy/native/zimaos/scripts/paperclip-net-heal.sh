#!/usr/bin/env bash
# Bring the wired port back when it has a cable link but no address
# (TOM-690). Started as root every minute by paperclip-native-net-heal.timer.
#
# Why: on 21 Oct the board came back from a power cut with a cable link on
# eth0 but no DHCP lease for 31 minutes. Paperclip was healthy on loopback,
# so nothing noticed; NetworkManager retried every 45 seconds and never got
# a lease. A power cycle fixed it. This script does the same thing a person
# would, in rising steps, and only while the port has no address:
#
#   - The port has an IPv4 address and a default route: do nothing. If an
#     outage was being tracked, log how long it lasted and clear it.
#   - No cable link (carrier 0): the cable, switch or router is off. Log it;
#     nothing on this host can fix that, so take no action.
#   - Cable link but no address for PAPERCLIP_NET_HEAL_GRACE seconds
#     (default 300): take the next step, at most one step per
#     PAPERCLIP_NET_HEAL_STEP_INTERVAL seconds (default 300):
#       1. nmcli device connect <iface>    (ask NetworkManager for a lease again)
#       2. link bounce: nmcli device disconnect, ip link down, ip link up,
#          nmcli device connect             (resets the NIC link, like a replug)
#       3. systemctl restart NetworkManager
#     then start again at step 1. The nmcli connect/disconnect calls run
#     only when NetworkManager already has a saved profile for the port:
#     on a port without one, `nmcli device connect` would create a new,
#     permanent profile (seen on the host test), so it is skipped.
#   - Optional last step, off by default: a clean `systemctl reboot` (what
#     fixed it on 21 Oct). Only with PAPERCLIP_NET_HEAL_REBOOT=1, only after
#     a full round of steps 1 to 3, only after PAPERCLIP_NET_HEAL_REBOOT_AFTER
#     seconds without an address (default 1800), never while an update holds
#     its lock, and at most once per PAPERCLIP_NET_HEAL_REBOOT_MIN_INTERVAL
#     seconds (default 21600, across reboots).
#
# Fails closed: if `ip` is missing, or either probe exits non-zero, the script
# cannot tell whether the port has an address. It then takes no action,
# leaves the outage state as it was, and exits 1 so the unit's OnFailure=
# alert fires. A broken tool must never look like "no address".
#
# A port that has an address is never touched. Every action and every
# outage end is appended to <root>/logs/network-heal.log, which agents can
# read without journal access. The outage state is per boot (it records the
# boot id), so a reboot starts a fresh grace period.
#
# Self-contained on purpose (no lib/common.sh): it lives in the recovery
# path outside every release.
#
# Environment: PAPERCLIP_NATIVE_ROOT (required), PAPERCLIP_NET_IFACE (eth0),
# PAPERCLIP_NET_HEAL_GRACE (300), PAPERCLIP_NET_HEAL_STEP_INTERVAL (300),
# PAPERCLIP_NET_HEAL_REBOOT (0), PAPERCLIP_NET_HEAL_REBOOT_AFTER (1800),
# PAPERCLIP_NET_HEAL_REBOOT_MIN_INTERVAL (21600). Test hooks:
# PAPERCLIP_SYS_CLASS_NET (/sys/class/net), PAPERCLIP_BOOT_ID_FILE,
# PAPERCLIP_UPTIME_FILE, PAPERCLIP_NOW, PAPERCLIP_NET_HEAL_BOUNCE_DELAY (3),
# PAPERCLIP_FLOCK_CMD (flock), PAPERCLIP_IP_CMD (ip).
#
# Usage: paperclip-net-heal.sh [--dry-run]
set -euo pipefail

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

ROOT="${PAPERCLIP_NATIVE_ROOT:?PAPERCLIP_NATIVE_ROOT must be set (see paperclip-native-net-heal.service)}"
IFACE="${PAPERCLIP_NET_IFACE:-eth0}"
GRACE="${PAPERCLIP_NET_HEAL_GRACE:-300}"
STEP_INTERVAL="${PAPERCLIP_NET_HEAL_STEP_INTERVAL:-300}"
REBOOT_ENABLED="${PAPERCLIP_NET_HEAL_REBOOT:-0}"
REBOOT_AFTER="${PAPERCLIP_NET_HEAL_REBOOT_AFTER:-1800}"
REBOOT_MIN_INTERVAL="${PAPERCLIP_NET_HEAL_REBOOT_MIN_INTERVAL:-21600}"
BOUNCE_DELAY="${PAPERCLIP_NET_HEAL_BOUNCE_DELAY:-3}"
SYS_CLASS_NET="${PAPERCLIP_SYS_CLASS_NET:-/sys/class/net}"
BOOT_ID_FILE="${PAPERCLIP_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}"
UPTIME_FILE="${PAPERCLIP_UPTIME_FILE:-/proc/uptime}"
LOG_DIR="$ROOT/logs"
STATE_FILE="$LOG_DIR/.paperclip-net-heal.state"
REBOOT_STAMP="$LOG_DIR/.paperclip-net-heal.last-reboot"
HEAL_LOG="$LOG_DIR/network-heal.log"
LOCK_FILE="$LOG_DIR/.paperclip-update.lock"
STEPS=3
FLOCK="${PAPERCLIP_FLOCK_CMD:-flock}"
IPCMD="${PAPERCLIP_IP_CMD:-ip}"

for v in GRACE STEP_INTERVAL REBOOT_AFTER REBOOT_MIN_INTERVAL BOUNCE_DELAY; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || { log "ERROR: $v must be a whole number of seconds (got: ${!v})"; exit 2; }
done
[[ "$IFACE" =~ ^[A-Za-z0-9_.:-]+$ ]] || { log "ERROR: PAPERCLIP_NET_IFACE is not an interface name: $IFACE"; exit 2; }

if [[ "${1:-}" == "--dry-run" ]]; then
  log "[dry-run] would check $IFACE for an IPv4 address and a default route; with an address it does nothing"
  log "[dry-run] with a cable link and no address for ${GRACE}s: one step per ${STEP_INTERVAL}s: nmcli device connect $IFACE; link bounce; systemctl restart NetworkManager; repeat"
  log "[dry-run] reboot step: $([[ "$REBOOT_ENABLED" == "1" ]] && echo "on, after ${REBOOT_AFTER}s, at most once per ${REBOOT_MIN_INTERVAL}s" || echo "off (PAPERCLIP_NET_HEAL_REBOOT=1 turns it on)")"
  log "[dry-run] state: $STATE_FILE; actions and outage ends: $HEAL_LOG"
  exit 0
fi

now() {
  if [[ -n "${PAPERCLIP_NOW:-}" ]]; then echo "$PAPERCLIP_NOW"; else date +%s; fi
}

# record <message>: journal and the persistent heal log.
record() {
  log "$*"
  mkdir -p "$LOG_DIR"
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$HEAL_LOG" 2>/dev/null \
    || log "WARNING: could not append to $HEAL_LOG"
}

if ! command -v "$IPCMD" >/dev/null 2>&1; then
  record "ERROR: $IPCMD is not installed; cannot tell whether $IFACE has an address. Taking no action."
  exit 1
fi

# probe <description> <ip args...>: sets PROBE_OUT to ip's output. Exits 1
# with no action when ip itself fails: that is "cannot tell", not "no address".
PROBE_OUT=""
probe() {
  local what="$1" rc=0
  shift
  PROBE_OUT="$("$IPCMD" "$@" 2>/dev/null)" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    record "ERROR: '$IPCMD $*' exited $rc; cannot tell whether $IFACE has $what. Taking no action and leaving the outage state unchanged."
    exit 1
  fi
}

# has_ipv4 / has_default_route: true or false. They run in this shell, so
# probe's exit 1 ends the script even inside an `if`.
has_ipv4() {
  probe "an IPv4 address" -4 -o addr show dev "$IFACE" scope global
  [[ -n "$PROBE_OUT" ]]
}

has_default_route() {
  probe "a default route" -4 route show default dev "$IFACE"
  [[ -n "$PROBE_OUT" ]]
}

# carrier: prints 1, 0, or unknown (an interface that is administratively
# down has no readable carrier; bringing it up is something step 2 can fix).
carrier() {
  local c
  if { read -r c <"$SYS_CLASS_NET/$IFACE/carrier"; } 2>/dev/null && [[ "$c" == "0" || "$c" == "1" ]]; then
    echo "$c"
  else
    echo unknown
  fi
}

boot_id() {
  local b=""
  { read -r b <"$BOOT_ID_FILE"; } 2>/dev/null || true
  echo "${b:-unknown}"
}

uptime_s() {
  local u=0 _rest
  { read -r u _rest <"$UPTIME_FILE"; } 2>/dev/null || true
  echo "${u%%.*}"
}

# nm_has_profile: NetworkManager has a saved profile it can use on IFACE.
nm_has_profile() {
  [[ -n "$(nmcli -g CONNECTIONS.AVAILABLE-CONNECTIONS device show "$IFACE" 2>/dev/null)" ]]
}

# update_running: true while paperclip-update.sh holds its lock. Fails
# closed: without flock it cannot tell, so it answers "running" and the
# reboot step stands back.
update_running() {
  [[ -e "$LOCK_FILE" ]] || return 1
  if ! command -v "$FLOCK" >/dev/null 2>&1; then
    log "WARNING: $FLOCK is not installed; cannot tell whether an update is running, so treating it as running."
    return 0
  fi
  ! "$FLOCK" -n "$LOCK_FILE" true
}

# State file: one line,
# "<boot-id> <down-since> <steps-taken> <last-step-at> <kind> <first-seen>".
# down-since restarts while there is no cable link (the grace period counts
# link-up time only); first-seen is when this outage was first noticed.
S_BOOT="" S_SINCE=0 S_STEPS=0 S_LAST=0 S_KIND="" S_FIRST=0
load_state() {
  local line=""
  { read -r line <"$STATE_FILE"; } 2>/dev/null || return 0
  read -r S_BOOT S_SINCE S_STEPS S_LAST S_KIND S_FIRST <<<"$line" || true
  if [[ "$S_BOOT" != "$BOOT" || ! "$S_SINCE" =~ ^[0-9]+$ || ! "$S_STEPS" =~ ^[0-9]+$ || ! "$S_LAST" =~ ^[0-9]+$ || ! "${S_FIRST:-}" =~ ^[0-9]+$ ]]; then
    # Another boot's outage (or a damaged file): start fresh.
    S_BOOT="" S_SINCE=0 S_STEPS=0 S_LAST=0 S_KIND="" S_FIRST=0
  fi
}
save_state() {
  mkdir -p "$LOG_DIR"
  printf '%s %s %s %s %s %s\n' "$BOOT" "$S_SINCE" "$S_STEPS" "$S_LAST" "${S_KIND:--}" "$S_FIRST" >"$STATE_FILE"
}

BOOT="$(boot_id)"
NOW="$(now)"
load_state

if ! [[ -e "$SYS_CLASS_NET/$IFACE" ]]; then
  log "$IFACE does not exist on this host; nothing to check (set PAPERCLIP_NET_IFACE)."
  exit 0
fi

if has_ipv4 && has_default_route; then
  if [[ -n "$S_BOOT" ]]; then
    record "Network back on $IFACE, $((NOW - S_FIRST))s after the outage was first noticed ($S_STEPS heal step(s) taken)."
    rm -f "$STATE_FILE"
  fi
  exit 0
fi

CARRIER="$(carrier)"
if [[ -z "$S_BOOT" ]]; then
  S_SINCE="$NOW" S_STEPS=0 S_LAST=0 S_KIND="" S_FIRST="$NOW"
fi
if [[ "$CARRIER" == "0" ]]; then
  # Nothing here can fix a missing cable link. Restart the grace period, so
  # the steps start only after a link has been up without an address.
  if [[ "$S_KIND" != "no-carrier" ]]; then
    record "$IFACE has no cable link (carrier 0) and no address. Not acting: the cable, switch or router is off."
  fi
  S_SINCE="$NOW" S_KIND="no-carrier"
  save_state
  exit 0
fi

if [[ "$S_KIND" != "no-address" ]]; then
  record "$IFACE has a cable link (carrier $CARRIER) but no IPv4 address or default route. Acting after ${GRACE}s if it stays like this."
  S_KIND="no-address" S_SINCE="$NOW"
fi
down_for=$((NOW - S_SINCE))
if ((down_for < GRACE)); then
  save_state
  exit 0
fi
if ((S_STEPS > 0 && NOW - S_LAST < STEP_INTERVAL)); then
  save_state
  exit 0
fi

# Optional reboot, after a full round of steps.
if [[ "$REBOOT_ENABLED" == "1" ]] && ((S_STEPS >= STEPS && down_for >= REBOOT_AFTER)); then
  last_reboot=""
  { read -r last_reboot <"$REBOOT_STAMP"; } 2>/dev/null || true
  [[ "$last_reboot" =~ ^[0-9]+$ ]] || last_reboot=""
  if update_running; then
    record "Would reboot ($IFACE has had no address for ${down_for}s), but paperclip-update.sh holds its lock. Not rebooting during an update."
  elif [[ -n "$last_reboot" ]] && ((NOW - last_reboot < REBOOT_MIN_INTERVAL)); then
    record "Would reboot ($IFACE has had no address for ${down_for}s), but this script rebooted $((NOW - last_reboot))s ago (limit: once per ${REBOOT_MIN_INTERVAL}s). Not rebooting; continuing with the other steps."
  elif (($(uptime_s) < REBOOT_AFTER)); then
    record "Would reboot, but the host has been up for less than ${REBOOT_AFTER}s. Not rebooting yet."
  else
    printf '%s\n' "$NOW" >"$REBOOT_STAMP"
    S_LAST="$NOW"
    save_state
    record "Rebooting: $IFACE has had a cable link but no address for ${down_for}s, and $S_STEPS heal steps did not bring it back."
    systemctl reboot
    exit 0
  fi
fi

step=$((S_STEPS % STEPS + 1))
use_nmcli=1
if [[ "$step" != "3" ]] && ! nm_has_profile; then
  use_nmcli=0
  record "NetworkManager has no saved profile for $IFACE; skipping nmcli connect/disconnect so no new profile is created."
fi
S_STEPS=$((S_STEPS + 1))
S_LAST="$NOW"
save_state
rc=0
case "$step" in
  1)
    record "Step 1 (of $STEPS): no address on $IFACE for ${down_for}s; asking NetworkManager to connect it again (nmcli device connect $IFACE)."
    if [[ "$use_nmcli" == "1" ]]; then nmcli --wait 60 device connect "$IFACE" || rc=$?; fi
    ;;
  2)
    record "Step 2 (of $STEPS): no address on $IFACE for ${down_for}s; bouncing the link (disconnect, link down, link up, connect)."
    if [[ "$use_nmcli" == "1" ]]; then nmcli --wait 20 device disconnect "$IFACE" || true; fi
    ip link set dev "$IFACE" down || rc=$?
    sleep "$BOUNCE_DELAY"
    ip link set dev "$IFACE" up || rc=$?
    if [[ "$use_nmcli" == "1" ]]; then nmcli --wait 60 device connect "$IFACE" || rc=$?; fi
    ;;
  3)
    record "Step 3 (of $STEPS): no address on $IFACE for ${down_for}s; restarting NetworkManager."
    systemctl restart NetworkManager || rc=$?
    ;;
esac
if [[ "$rc" -ne 0 ]]; then
  record "Step $step returned exit $rc; the next step follows in ${STEP_INTERVAL}s if $IFACE still has no address."
fi
exit 0
