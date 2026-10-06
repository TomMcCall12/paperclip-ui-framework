#!/usr/bin/env bash
# Shared helpers for the deploy/native scripts: logging, dry-run gating and
# a couple of guards (root, command presence) every script here needs.
# Source it; do not execute it directly.

# DRY_RUN must already be set (0 or 1) by the sourcing script before using run().
: "${DRY_RUN:=0}"

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

# run <description> -- <command...>
# Prints the description (and the exact command) under --dry-run instead of
# executing it. Every mutating action in these scripts goes through this so
# --dry-run has one enforcement point instead of an if/else at every call site.
run() {
  local desc="$1"
  shift
  if [[ "${1:-}" != "--" ]]; then
    die "run(): expected '--' before the command, got '${1:-}'"
  fi
  shift
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %s\n' "$desc"
    printf '[dry-run]   $ %s\n' "$(printf '%q ' "$@")"
    return 0
  fi
  log "$desc"
  "$@"
}

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    die "This script must run as root (it partitions disks / writes system files)."
  fi
}

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "Required command not found on PATH: $cmd"
  done
}

# resolve_disk_by_model_serial <model-substring> <serial-substring>
# Finds exactly one whole-disk block device by matching lsblk MODEL/SERIAL
# fields, never by kernel name (sdX/nvmeX names are not stable once a second
# drive is added). Prints the resolved /dev path, or dies.
resolve_disk_by_model_serial() {
  local model="$1" serial="$2" lsblk_json
  lsblk_json="$(lsblk -J -o NAME,TYPE,MODEL,SERIAL,PATH)"
  python3 -I - "$model" "$serial" "$lsblk_json" <<'PY'
import json, sys
model, serial, lsblk_json = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.loads(lsblk_json)
matches = []
def walk(devices):
    for d in devices:
        if d.get("type") == "disk":
            m = (d.get("model") or "").strip()
            s = (d.get("serial") or "").strip()
            if (not model or model in m) and (not serial or serial in s):
                matches.append(d.get("path") or f"/dev/{d.get('name')}")
walk(data.get("blockdevices", []))
if len(matches) != 1:
    sys.stderr.write(f"Expected exactly one disk matching model~={model!r} serial~={serial!r}, found {matches}\n")
    sys.exit(1)
print(matches[0])
PY
}

# disk_has_partitions <dev>
# True (exit 0) if the whole-disk device already has one or more partitions.
disk_has_partitions() {
  local dev="$1" lsblk_json count
  lsblk_json="$(lsblk -J -o NAME,TYPE "$dev")"
  count="$(python3 -I - "$lsblk_json" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
devs = data.get("blockdevices", [])
n = sum(1 for d in devs for c in d.get("children", []) if c.get("type") == "part")
print(n)
PY
)"
  [[ "${count:-0}" -gt 0 ]]
}

# with_retry <description> <max-attempts> <base-delay-seconds> -- <command...>
# Retries a flaky command (rclone against a flaky Drive API, say) with
# exponential backoff: base, base*2, base*4, ... Honors DRY_RUN via run().
with_retry() {
  local desc="$1" max_attempts="$2" base_delay="$3"
  shift 3
  if [[ "${1:-}" != "--" ]]; then
    die "with_retry(): expected '--' before the command, got '${1:-}'"
  fi
  shift
  local attempt=1 delay="$base_delay"
  while true; do
    if [[ "$DRY_RUN" == "1" ]]; then
      printf '[dry-run] %s (attempt %d/%d, retrying with backoff on failure)\n' "$desc" "$attempt" "$max_attempts"
      printf '[dry-run]   $ %s\n' "$(printf '%q ' "$@")"
      return 0
    fi
    log "$desc (attempt $attempt/$max_attempts)"
    if "$@"; then
      return 0
    fi
    if [[ "$attempt" -ge "$max_attempts" ]]; then
      die "$desc failed after $max_attempts attempts"
    fi
    log "Attempt $attempt failed, retrying in ${delay}s..."
    sleep "$delay"
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done
}

# resolve_or_placeholder <placeholder-text> <resolver-fn> [args...]
# Under --dry-run, prints the placeholder instead of calling the resolver, so
# the dry run never needs real disks/UUIDs/boot entries to produce its plan.
# In a real run, calls through to the resolver and prints its real output.
resolve_or_placeholder() {
  local placeholder="$1"
  shift
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '%s\n' "$placeholder"
  else
    "$@"
  fi
}
