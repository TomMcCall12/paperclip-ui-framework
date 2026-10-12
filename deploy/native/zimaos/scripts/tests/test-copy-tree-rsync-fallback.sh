#!/usr/bin/env bash
# Offline test for copy_tree/copy_tree_mirror's rsync-absent fallback
# (TOM-265). ZimaOS is a Buildroot appliance with no package manager, and
# the board's rsync presence was unconfirmed when this was written -- if
# it is absent, install-native-zimaos.sh's --data-src restore must not
# simply abort. This proves the `tar -C <src> -cf - . | tar -C <dst> -xf -`
# fallback in deploy/native/lib/common.sh produces a tree identical to the
# source -- same relative paths, same file sizes, same permission bits --
# with rsync masked out of PATH entirely, so the fallback branch is the
# only one that can run. Covers both copy_tree (additive) and
# copy_tree_mirror (delete-extraneous).
#
# Usage: test-copy-tree-rsync-fallback.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIMAOS_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
NATIVE_DIR="$(cd "$ZIMAOS_DIR/.." && pwd)"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(make_exec_capable_tempdir paperclip-copy-tree-test "$NATIVE_DIR")"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# rsync_masked_path <extra-dirs...>
# Builds a directory of symlinks to just the tools copy_tree/copy_tree_mirror
# and this test actually need, deliberately excluding rsync's own directory
# (and rsync itself), then prints that directory's path. Using a curated
# symlink dir rather than filtering $PATH entry-by-entry guarantees rsync
# cannot be found via any PATH entry, not just the ones it happens to share
# with other tools on this host.
rsync_masked_path() {
  local bindir="$WORKDIR/masked-bin" tool resolved
  mkdir -p "$bindir"
  for tool in tar find stat mkdir rm chmod cat sort env bash sh coreutils; do
    resolved="$(command -v "$tool" 2>/dev/null || true)"
    [[ -n "$resolved" ]] && ln -sf "$resolved" "$bindir/$tool"
  done
  printf '%s\n' "$bindir"
}

# tree_manifest <dir>
# Prints one line per entry under <dir> (relative path, type, size for
# files, permission bits), sorted by path -- enough to prove two trees are
# structurally and permission-identical regardless of which copy backend
# produced them.
tree_manifest() {
  local dir="$1" entry type size mode
  (
    cd "$dir"
    find . -mindepth 1 | LC_ALL=C sort | while IFS= read -r entry; do
      if [[ -d "$entry" ]]; then
        type=D; size=-
      else
        type=F; size="$(stat -c%s "$entry")"
      fi
      mode="$(stat -c%a "$entry")"
      printf '%s\t%s\t%s\t%s\n' "$entry" "$type" "$size" "$mode"
    done
  )
}

# --- Build a source tree with varied structure and permissions -------------
SRC="$WORKDIR/src"
mkdir -p "$SRC/subdir/deep"
printf 'hello\n' > "$SRC/file-644.txt"
chmod 644 "$SRC/file-644.txt"
printf '#!/bin/sh\necho hi\n' > "$SRC/file-755.sh"
chmod 755 "$SRC/file-755.sh"
printf 'nested\n' > "$SRC/subdir/nested.txt"
chmod 640 "$SRC/subdir/nested.txt"
printf 'deep content here\n' > "$SRC/subdir/deep/deep.txt"
chmod 600 "$SRC/subdir/deep/deep.txt"

SRC_MANIFEST="$(tree_manifest "$SRC")"

MASKED_BIN="$(rsync_masked_path)"
if PATH="$MASKED_BIN" command -v rsync >/dev/null 2>&1; then
  fail "rsync is still resolvable under the masked PATH -- the test setup did not actually mask it"
fi

# --- Case 1: copy_tree with rsync masked out of PATH -> identical tree -----
DST1="$WORKDIR/dst-copy-tree"
if ! PATH="$MASKED_BIN" bash -c "source '$NATIVE_DIR/lib/common.sh' && copy_tree '$SRC' '$DST1'"; then
  fail "copy_tree failed with rsync masked out of PATH"
fi
DST1_MANIFEST="$(tree_manifest "$DST1")"
if [[ "$DST1_MANIFEST" != "$SRC_MANIFEST" ]]; then
  diff <(printf '%s\n' "$SRC_MANIFEST") <(printf '%s\n' "$DST1_MANIFEST") >&2 || true
  fail "copy_tree's rsync-absent fallback produced a tree that differs from the source (see diff above)"
fi
echo "PASS: copy_tree's tar fallback produces an identical tree (paths, sizes, modes) with rsync absent from PATH"

# --- Case 2: copy_tree_mirror with rsync masked -> identical tree, and ------
# --- actually removes a pre-existing extraneous file at the destination ----
DST2="$WORKDIR/dst-copy-tree-mirror"
mkdir -p "$DST2"
printf 'stale, should be removed\n' > "$DST2/stale-extraneous-file.txt"
if ! PATH="$MASKED_BIN" bash -c "source '$NATIVE_DIR/lib/common.sh' && copy_tree_mirror '$SRC' '$DST2'"; then
  fail "copy_tree_mirror failed with rsync masked out of PATH"
fi
[[ ! -e "$DST2/stale-extraneous-file.txt" ]] || fail "copy_tree_mirror's tar fallback left a pre-existing extraneous file in place (--delete semantics not honored)"
DST2_MANIFEST="$(tree_manifest "$DST2")"
if [[ "$DST2_MANIFEST" != "$SRC_MANIFEST" ]]; then
  diff <(printf '%s\n' "$SRC_MANIFEST") <(printf '%s\n' "$DST2_MANIFEST") >&2 || true
  fail "copy_tree_mirror's rsync-absent fallback produced a tree that differs from the source (see diff above)"
fi
echo "PASS: copy_tree_mirror's tar fallback mirrors the source exactly (removes extraneous files, matches paths/sizes/modes) with rsync absent from PATH"

echo "All copy_tree rsync-fallback test cases passed."
