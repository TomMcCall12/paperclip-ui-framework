#!/usr/bin/env bash
# Native self-update for the ZimaOS install (TOM-256). Same contract as
# deploy/native/paperclip-deploy's `deploy` command: dump the DB, build the
# new release, switch `current`, restart, health-check, and on failure
# switch `current` back (restoring the DB dump too, if a migration ran)
# and restart again. Replaces the hour-long Docker image build with a
# native build whose measured/expected time is in README.md.
#
# Usage:
#   paperclip-update.sh --commit <sha> --repo-src <local-path> \
#     [--root <path>] [--min-build-memory-mb <n>] \
#     [--build-memory-poll-seconds <n>] [--dry-run]
#
# --repo-src is a local checkout path -- same no-remote-git-clone
# constraint as install-native-zimaos.sh (see its header).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIMAOS_DIR="$SCRIPT_DIR"
NATIVE_DIR="$(cd "$ZIMAOS_DIR/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

DRY_RUN=0
COMMIT=""
REPO_SRC=""
ROOT="/DATA/.media/External SSD/paperclip-native"
MIN_BUILD_MEMORY_MB=1200
BUILD_MEMORY_POLL_SECONDS=10
PAPERCLIP_USER="paperclip"
HEALTH_CHECK_ATTEMPTS=12
HEALTH_CHECK_DELAY=5
KEEP_RELEASES=5
MIGRATIONS_PATH="packages/db/src/migrations"
# The only workspace package whose build needs a C compiler (TOM-283/
# TOM-286): a separate host-only broker daemon this native install does not
# run or ship a unit for (see deploy/native/zimaos/systemd/ -- no broker
# unit there). Excluded from the release build on a host with no compiler,
# rather than installing one. Same constant and same resolve_c_compiler()
# probe (deploy/native/lib/common.sh) as install-native-zimaos.sh.
TAILSCALE_BROKER_PACKAGE="@paperclipai/tailscale-https-broker"

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --repo-src) REPO_SRC="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    --min-build-memory-mb) MIN_BUILD_MEMORY_MB="$2"; shift 2 ;;
    --build-memory-poll-seconds) BUILD_MEMORY_POLL_SECONDS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$COMMIT" ]] || die "Give --commit <sha>"
[[ "$COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || die "--commit must be a hex git sha (got: $COMMIT)"
[[ -n "$REPO_SRC" ]] || die "Give --repo-src <local-path>"
if [[ "$DRY_RUN" != "1" ]]; then
  [[ -d "$REPO_SRC" ]] || die "--repo-src '$REPO_SRC' is not a directory."
  require_root
  # `runuser` is not hard-required: resolve_drop_privileges_helper() (used
  # via drop_priv_run below) falls back to setpriv or su if it is absent
  # on this host (see install-native-zimaos.sh for why).
  require_cmd systemctl tar git curl
fi

PAPERCLIP_CURRENT="$ROOT/current"
RELEASES_DIR="$ROOT/releases"
PAPERCLIP_HOME="$ROOT/data"
ENV_FILE="$ROOT/env/paperclip-native.env"
SNAPSHOT_DIR="$ROOT/data/.pre-update-snapshot"

BUILD_ENV=(
  "HOME=$ROOT/home"
  "TMPDIR=$ROOT/home/.tmp"
  "XDG_CACHE_HOME=$ROOT/home/.cache"
  "XDG_CONFIG_HOME=$ROOT/home/.config"
  "XDG_DATA_HOME=$ROOT/home/.local/share"
  "XDG_STATE_HOME=$ROOT/home/.local/state"
  "npm_config_cache=$ROOT/home/.cache/npm"
  "PNPM_HOME=$ROOT/home/.local/share/pnpm"
  "PATH=$ROOT/toolchain/node/bin:$PATH"
)

require_port_from_env_file "$ENV_FILE" "$DRY_RUN"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

current_commit() {
  if [[ -L "$PAPERCLIP_CURRENT" ]]; then
    basename "$(readlink -f "$PAPERCLIP_CURRENT")"
  else
    echo "none"
  fi
}

check_health() {
  curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1
}

wait_for_health() {
  local i
  for ((i = 1; i <= HEALTH_CHECK_ATTEMPTS; i++)); do
    if check_health; then
      log "Health check OK (attempt $i/$HEALTH_CHECK_ATTEMPTS)"
      return 0
    fi
    log "Health check not ready yet (attempt $i/$HEALTH_CHECK_ATTEMPTS)"
    sleep "$HEALTH_CHECK_DELAY"
  done
  return 1
}

prev_release="$(readlink -f "$PAPERCLIP_CURRENT" 2>/dev/null || true)"
prev_commit="$(current_commit)"
log "Updating to $COMMIT (currently $prev_commit)"

log "== Pre-update DB snapshot =="
run "Logical DB dump (pnpm paperclipai db:backup)" -- \
  bash -c "cd '$PAPERCLIP_CURRENT' && PAPERCLIP_HOME='$PAPERCLIP_HOME' pnpm paperclipai db:backup"
if [[ -d "$PAPERCLIP_HOME/db" ]]; then
  run "Snapshot \$PAPERCLIP_HOME/db -> $SNAPSHOT_DIR/db (for instant rollback)" -- \
    copy_tree_mirror "$PAPERCLIP_HOME/db" "$SNAPSHOT_DIR/db"
fi

migration_ran=0
if [[ "$prev_commit" != "none" && -d "$RELEASES_DIR/.git-mirror.git" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] would check whether $MIGRATIONS_PATH differs between $prev_commit and $COMMIT"
  elif git -C "$RELEASES_DIR/.git-mirror.git" diff --quiet "$prev_commit" "$COMMIT" -- "$MIGRATIONS_PATH" 2>/dev/null; then
    migration_ran=0
  else
    migration_ran=1
    log "Migrations differ between $prev_commit and $COMMIT; a failed health check will restore the DB snapshot too."
  fi
fi

log "== Checking for a C compiler ($TAILSCALE_BROKER_PACKAGE's native add-on is the only thing that needs one) =="
resolve_c_compiler
BUILD_EXCLUDE_ARGS=()
if [[ -n "$C_COMPILER" ]]; then
  log "C compiler resolved: $C_COMPILER"
else
  log "No C compiler on this host; excluding $TAILSCALE_BROKER_PACKAGE from the release build - host-only broker daemon, no native unit runs it"
  BUILD_EXCLUDE_ARGS=(--exclude-package "$TAILSCALE_BROKER_PACKAGE")
fi

log "== Build $COMMIT (memory-guarded) =="
require_memory_available_mb "$MIN_BUILD_MEMORY_MB" "building release $COMMIT"
run_memory_guarded "Build release $COMMIT as $PAPERCLIP_USER" "$MIN_BUILD_MEMORY_MB" "$BUILD_MEMORY_POLL_SECONDS" -- \
  drop_priv_run "$PAPERCLIP_USER" -- env "${BUILD_ENV[@]}" \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$REPO_SRC" \
  "$NATIVE_DIR/scripts/build-release.sh" --commit "$COMMIT" --dest "$RELEASES_DIR/$COMMIT" --repo-src "$REPO_SRC" \
  "${BUILD_EXCLUDE_ARGS[@]}"

log "== Switch current and restart =="
run "Point current at $RELEASES_DIR/$COMMIT" -- ln -sfn "$RELEASES_DIR/$COMMIT" "$PAPERCLIP_CURRENT"
run "Restart paperclip-native.service" -- systemctl restart paperclip-native.service

if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would wait for $HEALTH_URL to become healthy (up to $((HEALTH_CHECK_ATTEMPTS * HEALTH_CHECK_DELAY))s)"
  log "[dry-run] on failure: switch current back to $prev_commit, restart, and (migration_ran=$migration_ran) restore the DB snapshot"
  log "[dry-run] on success: prune releases beyond the last $KEEP_RELEASES"
  exit 0
fi

if wait_for_health; then
  log "Update to $COMMIT succeeded."
  log "Pruning releases beyond the last $KEEP_RELEASES..."
  # Release dir names are git commit SHAs (safe charset); ls|grep is fine here.
  # shellcheck disable=SC2012,SC2010
  ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null \
    | grep -v '\.git-mirror\.git/$' \
    | grep -v "^$RELEASES_DIR/$COMMIT/\$" \
    | tail -n "+$KEEP_RELEASES" \
    | while read -r old; do rm -rf "${old%/}"; done
  exit 0
fi

log "Health check failed after updating to $COMMIT. Rolling back to $prev_commit..."
[[ -n "$prev_release" ]] || die "No previous release to roll back to. Manual intervention required."
ln -sfn "$prev_release" "$PAPERCLIP_CURRENT"
systemctl restart paperclip-native.service
if [[ "$migration_ran" == "1" && -d "$SNAPSHOT_DIR/db" ]]; then
  log "Migration ran during the failed update; restoring the pre-update DB snapshot."
  systemctl stop paperclip-native.service
  copy_tree_mirror "$SNAPSHOT_DIR/db" "$PAPERCLIP_HOME/db"
  systemctl start paperclip-native.service
fi
if wait_for_health; then
  die "Update to $COMMIT failed and was rolled back to $prev_commit successfully."
else
  die "Update to $COMMIT failed AND the rollback to $prev_commit did not pass its health check. Manual intervention required."
fi
