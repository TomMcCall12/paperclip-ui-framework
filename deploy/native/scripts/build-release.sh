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
#   build-release.sh --commit <sha> --dest <release-dir> \
#     (--repo-src <local-path> | --repo-url <url>) \
#     [--exclude-package <pnpm-package-name>]... \
#     [--workspace-concurrency <n>] [--dry-run]
#
# --repo-src clones the mirror from a local checkout path -- no GitHub
# credential involved. This is the migration-day route: the host building
# the very first release holds no GitHub credential, and TomMcCall12/toms-lab
# is private, so a plain --repo-url clone fails there. --repo-url remains
# for later use once the host has its own credential (e.g. a deploy key).
#
# --exclude-package drops one workspace package from the build (repeatable).
# With none given, this runs the plain root `pnpm run build` -- unchanged
# from before this option existed. With one or more given, it runs the root
# build's two steps individually -- `pnpm run preflight:workspace-links`
# then `pnpm -r build` -- so the second step can carry a `--filter '!<pkg>'`
# per exclusion. The caller is responsible for deciding *why* a package
# should be excluded (e.g. a host missing a C compiler); this script only
# logs which package names it was told to exclude and applies the filter.
#
# --workspace-concurrency caps how many workspace packages `pnpm -r build`
# builds at once (pnpm's own default is 4). Given, it also selects the
# two-step form, so the cap reaches the recursive build. paperclip-update.sh
# passes 2 (TOM-686): an uncapped build took the host down on 21 Oct.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

DRY_RUN=0
COMMIT=""
DEST=""
REPO_URL="https://github.com/TomMcCall12/toms-lab.git"
REPO_SRC=""
PNPM_VERSION="9.15.4"
EXCLUDE_PACKAGES=()
WORKSPACE_CONCURRENCY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    --repo-url) REPO_URL="$2"; shift 2 ;;
    --repo-src) REPO_SRC="$2"; shift 2 ;;
    --exclude-package) EXCLUDE_PACKAGES+=("$2"); shift 2 ;;
    --workspace-concurrency) WORKSPACE_CONCURRENCY="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[[ -n "$COMMIT" ]] || die "Give --commit <sha>"
[[ "$COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || die "--commit must be a hex git sha (got: $COMMIT)"
[[ -n "$DEST" ]] || die "Give --dest <release-dir>"
[[ -z "$WORKSPACE_CONCURRENCY" || "$WORKSPACE_CONCURRENCY" =~ ^[1-9][0-9]*$ ]] \
  || die "--workspace-concurrency must be a positive whole number (got: $WORKSPACE_CONCURRENCY)"
if [[ -n "$REPO_SRC" && "$DRY_RUN" != "1" ]]; then
  [[ -d "$REPO_SRC" ]] || die "--repo-src '$REPO_SRC' is not a directory."
fi

MIRROR_DIR="$(dirname "$DEST")/.git-mirror.git"

if [[ -d "$MIRROR_DIR" ]]; then
  # origin's URL was fixed at clone time below (repo-src path or repo-url);
  # fetching by remote name reuses whichever one that mirror was created from.
  run "Fetch latest refs into the shared mirror" -- git -C "$MIRROR_DIR" fetch --prune origin
elif [[ -n "$REPO_SRC" ]]; then
  run "Create the shared bare mirror at $MIRROR_DIR from the local checkout $REPO_SRC" -- \
    git clone --mirror "$REPO_SRC" "$MIRROR_DIR"
else
  run "Create the shared bare mirror at $MIRROR_DIR" -- git clone --mirror "$REPO_URL" "$MIRROR_DIR" \
    || die "Cloning $REPO_URL failed. It is a private repository and this host may hold no GitHub credential -- use --repo-src <path> to mirror from a local checkout instead (the migration-day route; see README.md)."
fi

if [[ -e "$DEST" ]]; then
  log "Release directory $DEST already exists; reusing it."
else
  run "Add a worktree for commit $COMMIT at $DEST" -- \
    git -C "$MIRROR_DIR" worktree add --detach "$DEST" "$COMMIT"
fi

run "Enable corepack" -- corepack enable
run "Pin pnpm $PNPM_VERSION via corepack" -- corepack prepare "pnpm@$PNPM_VERSION" --activate

FILTER_ARGS=()
for pkg in "${EXCLUDE_PACKAGES[@]}"; do
  FILTER_ARGS+=(--filter "!$pkg")
done
CONCURRENCY_ARGS=()
if [[ -n "$WORKSPACE_CONCURRENCY" ]]; then
  CONCURRENCY_ARGS=(--workspace-concurrency="$WORKSPACE_CONCURRENCY")
fi
# The plain root `pnpm run build` cannot carry filters or the concurrency
# cap, so either one selects its two steps run individually.
TWO_STEP=0
if [[ ${#EXCLUDE_PACKAGES[@]} -gt 0 || -n "$WORKSPACE_CONCURRENCY" ]]; then
  TWO_STEP=1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would run in $DEST: pnpm install --frozen-lockfile"
  if [[ "$TWO_STEP" == "0" ]]; then
    log "[dry-run] would run in $DEST: pnpm run build"
  else
    for pkg in "${EXCLUDE_PACKAGES[@]}"; do
      log "[dry-run] excluding workspace package from the release build (--exclude-package): $pkg"
    done
    log "[dry-run] would run in $DEST: pnpm run preflight:workspace-links"
    log "[dry-run] would run in $DEST: pnpm -r ${CONCURRENCY_ARGS[*]}${CONCURRENCY_ARGS[*]:+ }${FILTER_ARGS[*]} build"
  fi
else
  (cd "$DEST" && run "pnpm install --frozen-lockfile" -- pnpm install --frozen-lockfile)
  if [[ "$TWO_STEP" == "0" ]]; then
    (cd "$DEST" && run "pnpm run build" -- pnpm run build)
  else
    for pkg in "${EXCLUDE_PACKAGES[@]}"; do
      log "Excluding workspace package from the release build (--exclude-package): $pkg"
    done
    (cd "$DEST" && run "pnpm run preflight:workspace-links" -- pnpm run preflight:workspace-links)
    (cd "$DEST" && run "pnpm -r build (excluding: ${EXCLUDE_PACKAGES[*]:-none}; ${CONCURRENCY_ARGS[*]:-default concurrency})" -- \
      pnpm -r "${CONCURRENCY_ARGS[@]}" "${FILTER_ARGS[@]}" build)
  fi
fi

log "Release $COMMIT built at $DEST"
