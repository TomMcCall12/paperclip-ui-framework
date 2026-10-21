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
#     [--root <path>] [--mount-path <path>] [--recovery-base <path>] \
#     [--build-memory-max <size>] [--build-swap-max <size>] \
#     [--host-memory-reserve-mb <n>] [--min-build-ceiling-mb <n>] \
#     [--max-swap-used-pct <n>] [--min-build-memory-mb <n>] \
#     [--build-memory-poll-seconds <n>] [--build-concurrency <n>] \
#     [--build-node-heap-mb <n>] [--build-go-memory-limit-mb <n>] \
#     [--dry-run]
#
# --repo-src is a local checkout path -- same no-remote-git-clone
# constraint as install-native-zimaos.sh (see its header). Sizes take an
# M or G suffix (e.g. 8G, 256M); a bare number is MB. Every memory flag,
# its default and the reason for it is in README.md ("Build memory safety").
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
MOUNT_PATH=""
RECOVERY_BASE=""
# Build memory safety (TOM-686); see README.md for each value's reason.
BUILD_MEMORY_MAX="8G"
BUILD_SWAP_MAX="256M"
HOST_MEMORY_RESERVE_MB=4096
MIN_BUILD_CEILING_MB=6144
MAX_SWAP_USED_PCT=50
MIN_BUILD_MEMORY_MB=2048
BUILD_MEMORY_POLL_SECONDS=10
BUILD_CONCURRENCY=2
BUILD_NODE_HEAP_MB=3072
BUILD_GO_MEMORY_LIMIT_MB=4096
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
  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

# size_to_mb <size>: 8G -> 8192, 256M -> 256, 512 -> 512.
size_to_mb() {
  local v="$1"
  case "$v" in
    *[Gg]) v="${v%[Gg]}"; [[ "$v" =~ ^[0-9]+$ ]] && { echo $((v * 1024)); return 0; } ;;
    *[Mm]) v="${v%[Mm]}"; [[ "$v" =~ ^[0-9]+$ ]] && { echo "$v"; return 0; } ;;
    *) [[ "$v" =~ ^[0-9]+$ ]] && { echo "$v"; return 0; } ;;
  esac
  die "Not a size: '$1' (use e.g. 8G, 256M or a number of MB)"
}

require_uint() {
  [[ "$2" =~ ^[0-9]+$ ]] || die "$1 must be a whole number (got: $2)"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --repo-src) REPO_SRC="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    --mount-path) MOUNT_PATH="$2"; shift 2 ;;
    --recovery-base) RECOVERY_BASE="$2"; shift 2 ;;
    --build-memory-max) BUILD_MEMORY_MAX="$2"; shift 2 ;;
    --build-swap-max) BUILD_SWAP_MAX="$2"; shift 2 ;;
    --host-memory-reserve-mb) HOST_MEMORY_RESERVE_MB="$2"; shift 2 ;;
    --min-build-ceiling-mb) MIN_BUILD_CEILING_MB="$2"; shift 2 ;;
    --max-swap-used-pct) MAX_SWAP_USED_PCT="$2"; shift 2 ;;
    --min-build-memory-mb) MIN_BUILD_MEMORY_MB="$2"; shift 2 ;;
    --build-memory-poll-seconds) BUILD_MEMORY_POLL_SECONDS="$2"; shift 2 ;;
    --build-concurrency) BUILD_CONCURRENCY="$2"; shift 2 ;;
    --build-node-heap-mb) BUILD_NODE_HEAP_MB="$2"; shift 2 ;;
    --build-go-memory-limit-mb) BUILD_GO_MEMORY_LIMIT_MB="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$COMMIT" ]] || die "Give --commit <sha>"
[[ "$COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || die "--commit must be a hex git sha (got: $COMMIT)"
[[ -n "$REPO_SRC" ]] || die "Give --repo-src <local-path>"
BUILD_MEMORY_MAX_MB="$(size_to_mb "$BUILD_MEMORY_MAX")"
BUILD_SWAP_MAX_MB="$(size_to_mb "$BUILD_SWAP_MAX")"
for pair in "--host-memory-reserve-mb:$HOST_MEMORY_RESERVE_MB" "--min-build-ceiling-mb:$MIN_BUILD_CEILING_MB" \
    "--max-swap-used-pct:$MAX_SWAP_USED_PCT" "--min-build-memory-mb:$MIN_BUILD_MEMORY_MB" \
    "--build-memory-poll-seconds:$BUILD_MEMORY_POLL_SECONDS" "--build-concurrency:$BUILD_CONCURRENCY" \
    "--build-node-heap-mb:$BUILD_NODE_HEAP_MB" "--build-go-memory-limit-mb:$BUILD_GO_MEMORY_LIMIT_MB"; do
  require_uint "${pair%%:*}" "${pair#*:}"
done
[[ "$BUILD_CONCURRENCY" -ge 1 ]] || die "--build-concurrency must be at least 1"
[[ "$MIN_BUILD_CEILING_MB" -le "$BUILD_MEMORY_MAX_MB" ]] || die "--min-build-ceiling-mb ($MIN_BUILD_CEILING_MB) is above --build-memory-max (${BUILD_MEMORY_MAX_MB}MB); no build could ever start."
if [[ "$DRY_RUN" != "1" ]]; then
  [[ -d "$REPO_SRC" ]] || die "--repo-src '$REPO_SRC' is not a directory."
  require_root
  # `runuser` is not hard-required: resolve_drop_privileges_helper() (used
  # via drop_priv_argv below) falls back to setpriv or su if it is absent
  # on this host (see install-native-zimaos.sh for why). flock guards
  # against two updates at once and tells the recovery unit to stand back.
  require_cmd systemctl tar git curl flock setsid install cmp
fi

PAPERCLIP_CURRENT="$ROOT/current"
RELEASES_DIR="$ROOT/releases"
PAPERCLIP_HOME="$ROOT/data"
ENV_FILE="$ROOT/env/paperclip-native.env"
SNAPSHOT_DIR="$ROOT/data/.pre-update-snapshot"

# The mount the install root lives on (RequiresMountsFor= in the units) and
# the recovery path the watchdog/alert scripts already use on this host:
# /usr/local/lib/paperclip where install-native-zimaos.sh could write it,
# else <root>/recovery.
[[ -n "$MOUNT_PATH" ]] || MOUNT_PATH="$(dirname "$ROOT")"
if [[ -z "$RECOVERY_BASE" ]]; then
  if [[ -x /usr/local/lib/paperclip/scripts/paperclip-watchdog.sh ]]; then
    RECOVERY_BASE="/usr/local/lib/paperclip"
  else
    RECOVERY_BASE="$ROOT/recovery"
  fi
fi
LOCK_FILE="$ROOT/logs/.paperclip-update.lock"

# NODE_OPTIONS caps each Node process (pnpm, vite, esbuild hosts).
# TypeScript 7's tsc is a Go binary that ignores NODE_OPTIONS; GOMEMLIMIT is
# its equivalent soft cap (measured: server tsc peaks ~6.6GB RSS without it,
# ~5.5GB with 2.5GiB). The scope's MemoryMax is the hard limit for both.
BUILD_ENV=(
  "NODE_OPTIONS=--max-old-space-size=$BUILD_NODE_HEAP_MB"
  "GOMEMLIMIT=${BUILD_GO_MEMORY_LIMIT_MB}MiB"
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
BUILD_SCOPE_UNIT="paperclip-build-${COMMIT:0:12}"

current_commit() {
  if [[ -L "$PAPERCLIP_CURRENT" ]]; then
    basename "$(readlink -f "$PAPERCLIP_CURRENT")"
  else
    echo "none"
  fi
}

wait_for_health() {
  wait_for_health_url "$HEALTH_URL" "$HEALTH_CHECK_ATTEMPTS" "$HEALTH_CHECK_DELAY"
}

log "== Update lock ($LOCK_FILE) =="
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would take an exclusive flock on $LOCK_FILE (refuse if another update holds it; paperclip-native-recover.service stands back while it is held)"
else
  mkdir -p "$(dirname "$LOCK_FILE")"
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "Another paperclip-update.sh holds $LOCK_FILE; refusing to run two updates at once."
fi

prev_release="$(readlink -f "$PAPERCLIP_CURRENT" 2>/dev/null || true)"
prev_commit="$(current_commit)"
UPDATE_HEALTH_URL="$HEALTH_URL"
UPDATE_CURRENT_LINK="$PAPERCLIP_CURRENT"
UPDATE_PREV_RELEASE="$prev_release"
UPDATE_HEALTH_ATTEMPTS="$HEALTH_CHECK_ATTEMPTS"
UPDATE_HEALTH_DELAY="$HEALTH_CHECK_DELAY"
# From here on, any failure or signal runs update_exit_safety_net
# (deploy/native/lib/common.sh): stop the build, check health, restart
# only if the server is down.
arm_update_exit_trap
log "Updating to $COMMIT (currently $prev_commit)"

log "== Host safety net: recovery scripts, units and drop-ins (idempotent) =="
install_safety_net "$ZIMAOS_DIR" "$ROOT" "$MOUNT_PATH" "$RECOVERY_BASE"

log "== Pre-update DB snapshot =="
UPDATE_PHASE="snapshot"
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
    UPDATE_MIGRATION_RAN=1
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

log "== Build $COMMIT (contained, memory-guarded) =="
UPDATE_PHASE="build"
require_build_preflight "building release $COMMIT" "$HOST_MEMORY_RESERVE_MB" "$MIN_BUILD_CEILING_MB" "$MAX_SWAP_USED_PCT"
drop_priv_argv "$PAPERCLIP_USER" -- env "${BUILD_ENV[@]}" \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$REPO_SRC" \
  "$NATIVE_DIR/scripts/build-release.sh" --commit "$COMMIT" --dest "$RELEASES_DIR/$COMMIT" --repo-src "$REPO_SRC" \
  --workspace-concurrency "$BUILD_CONCURRENCY" "${BUILD_EXCLUDE_ARGS[@]}"
run_memory_guarded "Build release $COMMIT as $PAPERCLIP_USER" "$MIN_BUILD_MEMORY_MB" "$BUILD_MEMORY_POLL_SECONDS" -- \
  "${DROP_PRIV_ARGV[@]}"

log "== Switch current and restart =="
UPDATE_PHASE="switched"
run "Point current at $RELEASES_DIR/$COMMIT" -- ln -sfn "$RELEASES_DIR/$COMMIT" "$PAPERCLIP_CURRENT"
UPDATE_PHASE="restarted"
run "Restart paperclip-native.service" -- systemctl restart paperclip-native.service

if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would wait for $HEALTH_URL to become healthy (up to $((HEALTH_CHECK_ATTEMPTS * HEALTH_CHECK_DELAY))s)"
  log "[dry-run] on failure: switch current back to $prev_commit, restart, and (migration_ran=$migration_ran) restore the DB snapshot"
  log "[dry-run] on success: prune releases beyond the last $KEEP_RELEASES"
  exit 0
fi

if wait_for_health; then
  UPDATE_PHASE="done"
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
UPDATE_PHASE="rollback"
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
