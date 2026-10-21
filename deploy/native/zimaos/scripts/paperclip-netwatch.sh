#!/usr/bin/env bash
# Check the network path to and from Paperclip, not only loopback (TOM-690).
# Run as the paperclip user every 5 minutes by
# paperclip-native-netwatch.timer. A non-zero exit fires the unit's
# OnFailure= Telegram alert (paperclip-native-alert@). It never restarts
# anything: paperclip-native-net-heal.timer does the healing.
#
# Why: on 21 Oct the board had no network address for 31 minutes while
# paperclip-native-watchdog stayed green, because it only asks
# 127.0.0.1 for /api/health.
#
# Checks, in order:
#   1. <iface> (PAPERCLIP_NET_IFACE, default eth0) has an IPv4 address and
#      a default route.
#   2. Paperclip answers /api/health on that LAN address (what other
#      devices on the network use), not only on 127.0.0.1.
#   3. DNS resolves PAPERCLIP_NETWATCH_DNS_NAME (default api.anthropic.com:
#      agent runs fail with EAI_AGAIN without it).
#   4. An HTTPS request to PAPERCLIP_NETWATCH_HTTPS_URL (default
#      https://api.anthropic.com/) gets any HTTP answer: the internet path
#      agents need works. Set it to an empty value to skip this check.
# Tailscale is not checked on its own: on 21 Oct its interface stayed up
# with no network underneath, so checks 1 to 4 already cover it.
#
# A failed round is tried once more after PAPERCLIP_NETWATCH_RETRY_DELAY
# seconds (default 20), so a short blip does not alert. Failures are also
# appended to <root>/logs/network-watch.log when PAPERCLIP_NATIVE_ROOT is
# set, for agents that cannot read the journal.
#
# Self-contained on purpose (no lib/common.sh): it lives in the recovery
# path outside every release.
#
# Usage: paperclip-netwatch.sh [--dry-run]
set -euo pipefail

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

IFACE="${PAPERCLIP_NET_IFACE:-eth0}"
PORT="${PORT:-3100}"
DNS_NAME="${PAPERCLIP_NETWATCH_DNS_NAME:-api.anthropic.com}"
HTTPS_URL="${PAPERCLIP_NETWATCH_HTTPS_URL-https://api.anthropic.com/}"
RETRY_DELAY="${PAPERCLIP_NETWATCH_RETRY_DELAY:-20}"
ROOT="${PAPERCLIP_NATIVE_ROOT:-}"

[[ "$RETRY_DELAY" =~ ^[0-9]+$ ]] || { log "ERROR: PAPERCLIP_NETWATCH_RETRY_DELAY must be a whole number (got: $RETRY_DELAY)"; exit 2; }
[[ "$IFACE" =~ ^[A-Za-z0-9_.:-]+$ ]] || { log "ERROR: PAPERCLIP_NET_IFACE is not an interface name: $IFACE"; exit 2; }

if [[ "${1:-}" == "--dry-run" ]]; then
  log "[dry-run] would check: $IFACE has an IPv4 address and default route; http://<$IFACE address>:$PORT/api/health answers; DNS resolves $DNS_NAME; ${HTTPS_URL:-<no HTTPS check>} answers"
  log "[dry-run] a failed round is retried after ${RETRY_DELAY}s; a second failure exits non-zero (Telegram alert via OnFailure=)"
  exit 0
fi

FAILURE=""
LAN_IP=""

check_round() {
  FAILURE=""
  LAN_IP="$(ip -4 -o addr show dev "$IFACE" scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }')"
  if [[ -z "$LAN_IP" ]]; then
    FAILURE="$IFACE has no IPv4 address (no DHCP lease?)"
    return 1
  fi
  if [[ -z "$(ip -4 route show default dev "$IFACE" 2>/dev/null)" ]]; then
    FAILURE="$IFACE has address $LAN_IP but no default route"
    return 1
  fi
  if ! curl -fsS --max-time 10 -o /dev/null "http://$LAN_IP:$PORT/api/health" 2>/dev/null; then
    FAILURE="Paperclip does not answer /api/health on the LAN address http://$LAN_IP:$PORT"
    return 1
  fi
  if ! getent ahosts "$DNS_NAME" >/dev/null 2>&1; then
    FAILURE="DNS cannot resolve $DNS_NAME"
    return 1
  fi
  if [[ -n "$HTTPS_URL" ]] && ! curl -sS --max-time 15 -o /dev/null "$HTTPS_URL" 2>/dev/null; then
    FAILURE="no HTTPS answer from $HTTPS_URL (internet path down)"
    return 1
  fi
  return 0
}

if check_round; then
  log "Network OK: $IFACE $LAN_IP, LAN health, DNS ($DNS_NAME)${HTTPS_URL:+, HTTPS ($HTTPS_URL)}."
  exit 0
fi
first="$FAILURE"
log "Network check failed: $first. Trying again in ${RETRY_DELAY}s."
sleep "$RETRY_DELAY"
if check_round; then
  log "Network OK on the second try (first try: $first)."
  exit 0
fi
log "ERROR: network check failed twice: $FAILURE"
if [[ -n "$ROOT" && -d "$ROOT/logs" ]]; then
  printf '[%s] network check failed twice: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$FAILURE" >>"$ROOT/logs/network-watch.log" 2>/dev/null || true
fi
exit 1
