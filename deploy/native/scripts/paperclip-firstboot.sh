#!/usr/bin/env bash
# First-boot health gate for the native cutover (TOM-130/TOM-202/TOM-224). Run
# once, right after the very first boot into Debian, by
# paperclip-firstboot.service. Nobody is present to watch this boot: the
# Paperclip container, Hermes and the lab-claude-remote session all lived on
# ZimaOS, so this script -- not a human -- decides whether the cutover
# worked.
#
# On success: records the outcome on the ESP (readable from ZimaOS
# afterwards without booting Debian), disables this unit so it never runs
# again, and exits 0.
# On failure, OR if Paperclip never starts at all (crash loop, dependency
# failure, mount failure): records the outcome (with diagnostic detail) on
# the ESP, then reboots. bootstrap-debian.sh only ever sets UEFI BootNext
# (never BootOrder), so that reboot lands back on ZimaOS with no human
# present, exactly as intended.
#
# This script is deliberately installed outside the release tree (see
# README.md) and its unit does not Require= paperclip.service, so a broken
# or half-built release, or a paperclip.service that never reaches "active"
# at all, cannot disable this gate -- only this script's own bounded
# deadline decides when to give up and reboot. See DEADLINE_SECONDS below
# for the margin and reasoning.
#
# Usage: paperclip-firstboot.sh [--dry-run]
#
# --dry-run only prints the plan (health URL, poll budget, where the status
# file lands) -- it never polls, writes the status file, disables the unit,
# or reboots. The real unit never passes this flag; it exists purely so the
# plan can be reviewed without a real first boot.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

PORT="${PORT:-3100}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
ESP_MOUNT="${ESP_MOUNT:-/boot/efi}"
STATUS_FILE="$ESP_MOUNT/paperclip-firstboot-status.txt"
UNIT_NAME="paperclip-firstboot.service"

# DEADLINE_SECONDS is the total wall-clock budget, from this script's start,
# to see a passing /api/health before giving up and rebooting back to
# ZimaOS. Chosen as a reasoned default, not a hardware measurement -- this
# task had no host access to the real board. Reasoning:
#   - The previous budget (documented in README.md) was 120s (2 minutes),
#     sized for steady-state restarts with no migration step.
#   - A native process (no container runtime, no image-layer unpack) should
#     start faster per se than the old Docker image did.
#   - But THIS boot also runs one-time DB migrations against a freshly
#     restored data directory (see doc/DATABASE.md), which steady-state
#     restarts never pay. That cost is data-dependent and unmeasured here.
#   - 240s (4 minutes) keeps the prior budget as a floor, doubles it for
#     migration + native-build-cold-start margin, and still bounds how long
#     a genuinely broken board sits unattended before the automatic
#     rollback fires. Re-measure against the real first-boot drill and
#     adjust this constant (keep systemd's TimeoutStartSec on
#     paperclip-firstboot.service comfortably above it) if the real number
#     differs.
# The FIRSTBOOT_TEST_* overrides below exist only for the offline test
# harness (deploy/native/scripts/tests/test-paperclip-firstboot.sh) -- never
# set them in a real env file.
DEADLINE_SECONDS="${FIRSTBOOT_TEST_DEADLINE_SECONDS:-240}"
POLL_INTERVAL_SECONDS="${FIRSTBOOT_TEST_POLL_INTERVAL_SECONDS:-5}"
CURL_MAX_TIME="${FIRSTBOOT_TEST_CURL_MAX_TIME:-5}"

if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would poll $HEALTH_URL for up to ${DEADLINE_SECONDS}s, checking every ${POLL_INTERVAL_SECONDS}s"
  log "[dry-run] on success: would write outcome=success to $STATUS_FILE, then run: systemctl disable $UNIT_NAME"
  log "[dry-run] on failure (including Paperclip never starting at all): would write outcome=failure with diagnostics to $STATUS_FILE, then run: systemctl reboot"
  exit 0
fi

write_status() {
  local outcome="$1"
  local paperclip_state
  paperclip_state="$(systemctl is-active paperclip.service 2>/dev/null || true)"
  {
    printf 'outcome=%s\n' "$outcome"
    printf 'checked_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'health_url=%s\n' "$HEALTH_URL"
    printf 'deadline_seconds=%s\n' "$DEADLINE_SECONDS"
    printf 'paperclip_service_state=%s\n' "${paperclip_state:-unknown}"
    if [[ "$outcome" != "success" ]]; then
      printf -- '--- journalctl -u paperclip.service -n 40 --no-pager ---\n'
      journalctl -u paperclip.service -n 40 --no-pager 2>&1 || printf '(journalctl unavailable)\n'
    fi
  } > "$STATUS_FILE" || log "WARNING: could not write $STATUS_FILE"
}

check_health() {
  curl -fsS --max-time "$CURL_MAX_TIME" "$HEALTH_URL" >/dev/null 2>&1
}

start_ts="$(date +%s)"
deadline_ts=$((start_ts + DEADLINE_SECONDS))

log "First-boot health gate: polling $HEALTH_URL for up to ${DEADLINE_SECONDS}s (every ${POLL_INTERVAL_SECONDS}s)"
while (( "$(date +%s)" < deadline_ts )); do
  if check_health; then
    log "Health check OK."
    write_status "success"
    log "Disabling $UNIT_NAME so it never runs again."
    systemctl disable "$UNIT_NAME" || log "WARNING: could not disable $UNIT_NAME"
    exit 0
  fi
  log "Health check not ready yet ($((deadline_ts - $(date +%s)))s left)"
  sleep "$POLL_INTERVAL_SECONDS"
done

log "Health check never passed within ${DEADLINE_SECONDS}s. Recording failure and rebooting."
write_status "failure"
systemctl reboot
