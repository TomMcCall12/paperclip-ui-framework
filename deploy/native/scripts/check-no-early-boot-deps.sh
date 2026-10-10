#!/usr/bin/env bash
# Assert that no unit in a given directory enters early boot or touches
# Docker/CasaOS/ZimaOS's own units (TOM-256). A 5 Oct change of exactly
# this shape -- adding a unit to local-fs.target.wants and depending on a
# late ZimaOS service -- created a systemd ordering cycle; systemd resolves
# a cycle by silently deleting start-up jobs, it deleted
# systemd-tmpfiles-setup.service on the next boot, and that took out sshd
# and the ZimaOS service, leaving the board unreachable for 16.5 hours.
# This check exists so a future edit cannot reintroduce that shape.
#
# Usage: check-no-early-boot-deps.sh --units-dir <dir>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

UNITS_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --units-dir) UNITS_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[[ -n "$UNITS_DIR" ]] || die "Give --units-dir <dir>"
[[ -d "$UNITS_DIR" ]] || die "--units-dir '$UNITS_DIR' is not a directory."

# Each pattern below is a lesson already paid for -- see the file header.
FORBIDDEN_PATTERNS=(
  'Before=sysinit\.target'
  'Before=local-fs\.target'
  'casaos-'
  'zimaos-'
  'var-lib-docker'
)

status=0
shopt -s nullglob
unit_files=("$UNITS_DIR"/*.service "$UNITS_DIR"/*.timer)
[[ ${#unit_files[@]} -gt 0 ]] || die "No *.service/*.timer files found under $UNITS_DIR"

for unit_path in "${unit_files[@]}"; do
  unit="$(basename "$unit_path")"
  # systemd unit files treat a line starting with '#' or ';' as a comment;
  # strip those before matching so an explanatory comment naming one of
  # these patterns (to say why the unit avoids it) doesn't trip this check.
  code_only="$(grep -vE '^[[:space:]]*[#;]' "$unit_path")"
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if matches="$(printf '%s\n' "$code_only" | grep -nE "$pattern" 2>/dev/null)"; then
      log "FAIL $unit: matches forbidden pattern '$pattern':"
      printf '%s\n' "$matches" | sed 's/^/  /' >&2
      status=1
    fi
  done
done

if [[ "$status" -eq 0 ]]; then
  log "OK: no unit under $UNITS_DIR enters early boot or touches Docker/CasaOS/ZimaOS units."
fi
exit "$status"
