#!/usr/bin/env bash
# Assert that every ExecStart= binary named by a systemd unit actually
# exists and is executable inside a target root, resolving symlinks within
# that root (TOM-224).
#
# verify-systemd-units.sh cannot catch a missing ExecStart target: its
# fakeroot pre-creates a stub file for every *known* script name before
# calling `systemd-analyze verify`, so it always finds something there --
# even if the real pre-stage forgot to put the file at that path (this is
# exactly how the firstboot-script-missing-from-the-release bug slipped
# past it). This script checks the real, already-staged target instead of
# a hand-made stand-in.
#
# Usage: check-execstart-targets.sh --root <dir> [--units-dir <dir>]
#
# --root is a directory shaped like a Debian root filesystem (a real mounted
# target, or a plain directory tree in tests). Absolute ExecStart paths, and
# the absolute symlinks they resolve through, are interpreted relative to
# this root, never the real /.
#
# --units-dir defaults to this script's own ../systemd (the checked-in unit
# files); pass a different directory in tests.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

ROOT=""
UNITS_DIR="$SCRIPT_DIR/../systemd"

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --units-dir) UNITS_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$ROOT" ]] || die "Give --root <dir> (the target root to check ExecStart binaries against)."
[[ -d "$ROOT" ]] || die "--root '$ROOT' is not a directory."
[[ -d "$UNITS_DIR" ]] || die "--units-dir '$UNITS_DIR' is not a directory."

# resolve_in_root <root> <absolute-path>
# Resolves symlinks in <absolute-path> one component at a time, scoped
# strictly inside <root>: an absolute symlink target is re-rooted under
# <root> rather than the real /, matching how the same symlink behaves once
# <root> is actually booted as /. Prints the final absolute path (in the
# root's own namespace, not prefixed with <root>).
resolve_in_root() {
  local root="$1" path="$2"
  python3 -I - "$root" "$path" <<'PY'
import os, sys

root, path = sys.argv[1], sys.argv[2]
MAX_LOOKUPS = 40
lookups = 0

# Walk the path one component at a time (not just the final component) so
# an intermediate symlink -- e.g. /srv/paperclip/current pointing at
# /srv/paperclip/releases/<commit>, with real path components after it --
# gets re-rooted under <root> too, matching how the same path would resolve
# once <root> is actually booted as /.
remaining = [p for p in path.split("/") if p not in ("", ".")]
resolved = []

while remaining:
    comp = remaining.pop(0)
    if comp == "..":
        if resolved:
            resolved.pop()
        continue
    full = os.path.join(root, *(resolved + [comp]))
    if os.path.islink(full):
        lookups += 1
        if lookups > MAX_LOOKUPS:
            sys.stderr.write(f"Symlink resolution for {path!r} exceeded {MAX_LOOKUPS} lookups under {root!r} (possible loop)\n")
            sys.exit(1)
        target = os.readlink(full)
        target_parts = [p for p in target.split("/") if p not in ("", ".")]
        if os.path.isabs(target):
            remaining = target_parts + remaining
            resolved = []
        else:
            remaining = target_parts + remaining
        continue
    resolved.append(comp)

print("/" + "/".join(resolved))
PY
}

status=0
shopt -s nullglob
unit_files=("$UNITS_DIR"/*.service)
[[ ${#unit_files[@]} -gt 0 ]] || die "No *.service files found under $UNITS_DIR"

for unit_path in "${unit_files[@]}"; do
  unit="$(basename "$unit_path")"
  while IFS= read -r line; do
    [[ "$line" =~ ^ExecStart= ]] || continue
    raw="${line#ExecStart=}"
    # Strip systemd's optional leading modifier characters (-, +, !, !!)
    # before the binary path.
    raw="$(printf '%s' "$raw" | sed -E 's/^[-+!]*//')"
    bin="${raw%% *}"
    [[ "$bin" == /* ]] || { log "SKIP $unit: ExecStart binary '$bin' is not an absolute path, not checked"; continue; }
    if ! resolved="$(resolve_in_root "$ROOT" "$bin")"; then
      log "FAIL $unit: could not resolve symlinks for $bin under $ROOT"
      status=1
      continue
    fi
    full="$ROOT$resolved"
    if [[ -f "$full" && -x "$full" ]]; then
      log "OK   $unit: $bin -> $resolved"
    else
      log "FAIL $unit: $bin -> $resolved (missing or not executable at $full)"
      status=1
    fi
  done < "$unit_path"
done

exit "$status"
