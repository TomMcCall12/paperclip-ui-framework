#!/usr/bin/env bash
# Assert that no script or unit in a given set of paths writes application
# state under /var, /tmp or /run (TOM-256). On ZimaOS those three are
# tmpfs and are wiped every boot; a design that silently drops data there
# instead of under <root> would only be discovered the next time the board
# reboots. Scoped to the ZimaOS tree by the caller -- the shelved Debian
# scripts intentionally use /tmp (a persistent, non-tmpfs filesystem there)
# for their own one-off staging and are not checked by this script.
#
# This is a literal-path grep, not a data-flow analysis: it flags any
# occurrence of "/var/", "/tmp/" or "/run/" outside a comment. A line that
# only *mentions* one of these paths in prose, to explain why the code
# avoids it, should stay out of the scanned files or be rephrased without
# the literal path -- see this file's own header for how to do that.
#
# Usage: check-no-state-outside-run-root.sh <file-or-dir>...
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

[[ $# -gt 0 ]] || die "Give one or more files or directories to scan."

FORBIDDEN_PATTERN='(^|[^A-Za-z0-9_.-])/(var|tmp|run)/'

status=0
scan_file() {
  local f="$1" line_no=0 line matches=0
  while IFS= read -r line; do
    line_no=$((line_no + 1))
    # Strip a leading-whitespace '#' comment line entirely; a trailing
    # inline comment is not stripped, so keep explanatory prose in a
    # standalone comment line, not appended after real code.
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ $FORBIDDEN_PATTERN ]]; then
      log "FAIL $f:$line_no: references /var, /tmp or /run outside a comment:"
      printf '  %s\n' "$line" >&2
      matches=1
    fi
  done < "$f"
  [[ "$matches" -eq 0 ]]
}

for target in "$@"; do
  if [[ -d "$target" ]]; then
    files=()
    while IFS= read -r -d '' f; do files+=("$f"); done < <(find "$target" -type f \( -name '*.sh' -o -name '*.service' -o -name '*.timer' \) -print0)
  else
    files=("$target")
  fi
  for f in "${files[@]}"; do
    scan_file "$f" || status=1
  done
done

if [[ "$status" -eq 0 ]]; then
  log "OK: no scanned script or unit references /var, /tmp or /run outside a comment."
fi
exit "$status"
