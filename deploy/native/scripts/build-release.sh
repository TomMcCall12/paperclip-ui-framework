#!/usr/bin/env bash
# Build one Tom's Lab (Paperclip) release at an exact commit into its own
# release directory, for the /srv/paperclip/releases/<commit> + `current`
# symlink layout. Shared by install-paperclip.sh (first install) and
# paperclip-deploy (every later deploy), so the build mechanics live in one
# place.
#
# Run this as the `paperclip` user (the caller is responsible for that, e.g.
# via `runuser -u paperclip --`). It keeps a single bare git mirror under
# /srv/paperclip/releases/.git-mirror.git and checks out each release as a
# git worktree off that mirror, so repeat deploys fetch instead of re-cloning
# the whole history.
#
# Usage:
#   build-release.sh --commit <sha> --dest <release-dir> [--repo-url <url>] [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

DRY_RUN=0
COMMIT=""
DEST=""
REPO_URL="https://github.com/TomMcCall12/toms-lab.git"
PNPM_VERSION="9.15.4"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    --repo-url) REPO_URL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[[ -n "$COMMIT" ]] || die "Give --commit <sha>"
[[ "$COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || die "--commit must be a hex git sha (got: $COMMIT)"
[[ -n "$DEST" ]] || die "Give --dest <release-dir>"

MIRROR_DIR="$(dirname "$DEST")/.git-mirror.git"

if [[ -d "$MIRROR_DIR" ]]; then
  run "Fetch latest refs into the shared mirror" -- git -C "$MIRROR_DIR" fetch --prune origin
else
  run "Create the shared bare mirror at $MIRROR_DIR" -- git clone --mirror "$REPO_URL" "$MIRROR_DIR"
fi

if [[ -e "$DEST" ]]; then
  log "Release directory $DEST already exists; reusing it."
else
  run "Add a worktree for commit $COMMIT at $DEST" -- \
    git -C "$MIRROR_DIR" worktree add --detach "$DEST" "$COMMIT"
fi

run "Enable corepack" -- corepack enable
run "Pin pnpm $PNPM_VERSION via corepack" -- corepack prepare "pnpm@$PNPM_VERSION" --activate

if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would run in $DEST: pnpm install --frozen-lockfile"
  log "[dry-run] would run in $DEST: pnpm run build"
else
  (cd "$DEST" && run "pnpm install --frozen-lockfile" -- pnpm install --frozen-lockfile)
  (cd "$DEST" && run "pnpm run build" -- pnpm run build)
fi

log "Release $COMMIT built at $DEST"
