#!/usr/bin/env bash
# Install Paperclip (Tom's Lab) natively on ZimaOS: a systemd service whose
# entire tree -- Node toolchain, release, data, env files, home, logs --
# lives on the external drive, with only the unit files and a recovery-path
# copy of a couple of scripts on the board itself (see README.md).
#
# Idempotent and additive: re-running this is safe. It never touches
# var-lib-docker.mount, any existing ZimaOS/CasaOS unit, or Docker itself --
# Docker stays installed but unused (see TOM-256).
#
# Usage:
#   install-native-zimaos.sh --commit <sha> --repo-src <local-path> \
#     [--root <path>] [--expected-root-uuid <uuid>] [--mount-path <path>] \
#     [--data-src <path>] \
#     [--paperclip-env-file <path>] [--telegram-env-file <path>] \
#     [--rclone-env-file <path>] \
#     [--min-build-memory-mb <n>] [--build-memory-poll-seconds <n>] \
#     [--dry-run]
#
# --repo-src is a LOCAL checkout path, never a URL: the board holds no
# GitHub credential and the repository is private, so there is no git
# clone from a remote anywhere in this script.
#
# --root defaults to "/DATA/.media/External SSD/paperclip-native". --mount-
# path (default "/DATA/.media/External SSD") is the filesystem the
# installer confirms is actually mounted, and -- if --expected-root-uuid is
# given -- confirms is backed by that exact filesystem UUID, never a
# /dev/sdX name (device enumeration has already shifted once on this board
# when a second drive was fitted).
#
# --data-src, if given, restores an existing ~/.paperclip/instances/default
# -shaped data directory (db/, data/, secrets/master.key) into <root>/data.
# Omit it for a brand-new install with no prior data.
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
MOUNT_PATH="/DATA/.media/External SSD"
EXPECTED_ROOT_UUID=""
DATA_SRC=""
PAPERCLIP_ENV_FILE=""
TELEGRAM_ENV_FILE=""
RCLONE_ENV_FILE=""
MIN_BUILD_MEMORY_MB=1200
BUILD_MEMORY_POLL_SECONDS=10
NODE_VERSION="24.21.0"
PAPERCLIP_USER="paperclip"
# The only workspace package whose build needs a C compiler (TOM-283): a
# separate host-only broker daemon this native install does not run or
# ship a unit for (see deploy/native/zimaos/systemd/ -- no broker unit
# there). Excluded from the release build on a host with no compiler,
# rather than installing one.
TAILSCALE_BROKER_PACKAGE="@paperclipai/tailscale-https-broker"

usage() {
  sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

# resolve_c_compiler() and its C_COMPILER var are defined in
# deploy/native/lib/common.sh (sourced above), shared with
# paperclip-update.sh (TOM-286).

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --repo-src) REPO_SRC="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    --mount-path) MOUNT_PATH="$2"; shift 2 ;;
    --expected-root-uuid) EXPECTED_ROOT_UUID="$2"; shift 2 ;;
    --data-src) DATA_SRC="$2"; shift 2 ;;
    --paperclip-env-file) PAPERCLIP_ENV_FILE="$2"; shift 2 ;;
    --telegram-env-file) TELEGRAM_ENV_FILE="$2"; shift 2 ;;
    --rclone-env-file) RCLONE_ENV_FILE="$2"; shift 2 ;;
    --min-build-memory-mb) MIN_BUILD_MEMORY_MB="$2"; shift 2 ;;
    --build-memory-poll-seconds) BUILD_MEMORY_POLL_SECONDS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$COMMIT" ]] || die "Give --commit <sha> (the exact commit to build)."
[[ "$COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || die "--commit must be a hex git sha (got: $COMMIT)"
[[ -n "$REPO_SRC" ]] || die "Give --repo-src <local-path> -- a local checkout. The board holds no GitHub credential and the repository is private; there is no git-clone-from-remote route here."
if [[ "$DRY_RUN" != "1" ]]; then
  [[ -d "$REPO_SRC" ]] || die "--repo-src '$REPO_SRC' is not a directory."
  [[ -z "$DATA_SRC" || -d "$DATA_SRC" ]] || die "--data-src '$DATA_SRC' is not a directory."
  for f in "$PAPERCLIP_ENV_FILE" "$TELEGRAM_ENV_FILE" "$RCLONE_ENV_FILE"; do
    [[ -z "$f" || -r "$f" ]] || die "'$f' is not readable."
  done
fi

if [[ "$DRY_RUN" != "1" ]]; then
  require_root
  # No `node`, `pnpm` or `corepack` here: they ship inside the Node
  # tarball this script itself downloads and SHA-256-verifies below, not
  # on the host PATH -- requiring them before that download has happened
  # can never succeed on a host with no system Node (confirmed absent on
  # the real board, TOM-264/TOM-265). Invoked by absolute path from
  # $ROOT/toolchain/node/bin once the tarball is in place. `runuser` is
  # not hard-required either: resolve_drop_privileges_helper() (used via
  # drop_priv_run below) falls back to setpriv or su if it is absent.
  require_cmd tar sha256sum curl findmnt blkid useradd getent chown systemctl git python3
fi

log "== Confirming the external drive is mounted at $MOUNT_PATH =="
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would require '$MOUNT_PATH' to exist and, if --expected-root-uuid was given, match that filesystem UUID"
else
  [[ -d "$MOUNT_PATH" ]] || die "'$MOUNT_PATH' does not exist -- the external drive is not mounted. Refusing to create $ROOT on whatever filesystem that path would otherwise resolve to."
  require_mount_uuid "$MOUNT_PATH" "$EXPECTED_ROOT_UUID"
fi

log "== Creating the <root> layout at $ROOT =="
run "Create <root> directories" -- mkdir -p \
  "$ROOT/toolchain/node" "$ROOT/releases" "$ROOT/data" "$ROOT/env" \
  "$ROOT/home" "$ROOT/logs" "$ROOT/recovery/scripts" "$ROOT/recovery/lib"
run "Create <root>/home dot-dirs (HOME/TMPDIR/XDG_*/npm/pnpm all pin here, never \$HOME or /var or /tmp)" -- mkdir -p \
  "$ROOT/home/.tmp" "$ROOT/home/.cache/npm" "$ROOT/home/.config" \
  "$ROOT/home/.local/share/pnpm/store" "$ROOT/home/.local/state"

log "== System user: $PAPERCLIP_USER, home $ROOT/home (never /home -- must survive a tmpfs/overlay wipe) =="
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would create group/user '$PAPERCLIP_USER' (system account, home $ROOT/home) if missing"
else
  if ! getent group "$PAPERCLIP_USER" >/dev/null; then
    run "Create group $PAPERCLIP_USER" -- groupadd --system "$PAPERCLIP_USER"
  fi
  if ! getent passwd "$PAPERCLIP_USER" >/dev/null; then
    run "Create system user $PAPERCLIP_USER" -- useradd --system --gid "$PAPERCLIP_USER" \
      --home-dir "$ROOT/home" --shell /usr/sbin/nologin "$PAPERCLIP_USER"
  fi
fi
run "Own <root> as $PAPERCLIP_USER" -- chown -R "$PAPERCLIP_USER:$PAPERCLIP_USER" "$ROOT"

log "== Node $NODE_VERSION toolchain (official tarball, SHA-256 verified) =="
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) NODE_PLATFORM="linux-x64" ;;
  aarch64) NODE_PLATFORM="linux-arm64" ;;
  *) die "Unsupported architecture for the Node tarball: $ARCH" ;;
esac
NODE_TARBALL="node-v${NODE_VERSION}-${NODE_PLATFORM}.tar.xz"
NODE_DIST_URL="https://nodejs.org/dist/v${NODE_VERSION}"
NODE_BIN="$ROOT/toolchain/node/bin/node"

INSTALLED_NODE_VERSION=""
if [[ "$DRY_RUN" != "1" && -x "$NODE_BIN" ]]; then
  INSTALLED_NODE_VERSION="$("$NODE_BIN" -v 2>/dev/null | sed 's/^v//')"
fi
if [[ "$INSTALLED_NODE_VERSION" == "$NODE_VERSION" ]]; then
  log "Node v$NODE_VERSION already installed at $NODE_BIN, skipping download."
else
  STAGE_DIR="$ROOT/home/.tmp/node-install.$$"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] would download $NODE_DIST_URL/$NODE_TARBALL and $NODE_DIST_URL/SHASUMS256.txt into a staging dir under $ROOT (never /tmp)"
    log "[dry-run] would verify the tarball's SHA-256 against the SHASUMS256.txt entry before extracting"
    log "[dry-run] would extract into $ROOT/toolchain/node (strip-components 1)"
  else
    run "Create staging dir $STAGE_DIR" -- mkdir -p "$STAGE_DIR"
    run "Download $NODE_TARBALL" -- curl -fsSL -o "$STAGE_DIR/$NODE_TARBALL" "$NODE_DIST_URL/$NODE_TARBALL"
    run "Download SHASUMS256.txt" -- curl -fsSL -o "$STAGE_DIR/SHASUMS256.txt" "$NODE_DIST_URL/SHASUMS256.txt"
    EXPECTED_SHA="$(awk -v f="$NODE_TARBALL" '$2==f {print $1}' "$STAGE_DIR/SHASUMS256.txt")"
    [[ -n "$EXPECTED_SHA" ]] || die "No SHASUMS256.txt entry found for $NODE_TARBALL"
    ACTUAL_SHA="$(sha256sum "$STAGE_DIR/$NODE_TARBALL" | awk '{print $1}')"
    [[ "$ACTUAL_SHA" == "$EXPECTED_SHA" ]] || die "SHA-256 mismatch for $NODE_TARBALL: expected $EXPECTED_SHA, got $ACTUAL_SHA. Refusing to extract an unverified Node build."
    log "SHA-256 verified for $NODE_TARBALL."
    run "Clear any previous partial toolchain" -- rm -rf "$ROOT/toolchain/node"
    run "Create $ROOT/toolchain/node" -- mkdir -p "$ROOT/toolchain/node"
    run "Extract $NODE_TARBALL into $ROOT/toolchain/node" -- \
      tar -xJf "$STAGE_DIR/$NODE_TARBALL" -C "$ROOT/toolchain/node" --strip-components=1
    run "Own the toolchain as $PAPERCLIP_USER" -- chown -R "$PAPERCLIP_USER:$PAPERCLIP_USER" "$ROOT/toolchain/node"
    run "Clean up the staging dir" -- rm -rf "$STAGE_DIR"
  fi
fi

log "== Pinning pnpm's store and npm/corepack caches under <root> (never \$HOME or /var) =="
# PNPM_HOME is pnpm's "global bin directory": pnpm refuses ANY --global
# config write (even an unrelated one, like store-dir) when that directory
# is absent from PATH (confirmed on the real board, TOM-288). Two
# independent fixes, both kept: PNPM_HOME is on PATH below so that refusal
# can never recur even if a future --global call is added here, and the
# store-dir pin itself goes through PNPM_CONFIG_STORE_DIR (a plain env var
# every pnpm invocation that inherits BUILD_ENV picks up) instead of a
# `pnpm config set --global` call, so this step writes no global pnpm
# config file at all -- nothing for the install to leave outside $ROOT.
PNPM_HOME_DIR="$ROOT/home/.local/share/pnpm"
BUILD_ENV=(
  "HOME=$ROOT/home"
  "TMPDIR=$ROOT/home/.tmp"
  "XDG_CACHE_HOME=$ROOT/home/.cache"
  "XDG_CONFIG_HOME=$ROOT/home/.config"
  "XDG_DATA_HOME=$ROOT/home/.local/share"
  "XDG_STATE_HOME=$ROOT/home/.local/state"
  "npm_config_cache=$ROOT/home/.cache/npm"
  "PNPM_HOME=$PNPM_HOME_DIR"
  "PNPM_CONFIG_STORE_DIR=$PNPM_HOME_DIR/store"
  "PATH=$ROOT/toolchain/node/bin:$PNPM_HOME_DIR:$PATH"
)
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would run as $PAPERCLIP_USER, with HOME/TMPDIR/XDG_*/npm_config_cache/PNPM_CONFIG_STORE_DIR pinned under $ROOT and PNPM_HOME on PATH: corepack enable (store-dir pinned via PNPM_CONFIG_STORE_DIR -- no global pnpm config write)"
else
  run "Enable corepack for the pinned Node toolchain" -- \
    drop_priv_run "$PAPERCLIP_USER" -- env "${BUILD_ENV[@]}" "$ROOT/toolchain/node/bin/corepack" enable
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

log "== Building release $COMMIT from the local checkout $REPO_SRC (memory-guarded) =="
RELEASE_DIR="$ROOT/releases/$COMMIT"
require_memory_available_mb "$MIN_BUILD_MEMORY_MB" "building release $COMMIT"
# $REPO_SRC may be a root-owned checkout; the build runs as $PAPERCLIP_USER,
# so git would otherwise refuse it as "dubious ownership". Trust that one
# path for this single invocation only -- never chown the source, write a
# global git config, or remount it writable.
run_memory_guarded "Build release $COMMIT as $PAPERCLIP_USER" "$MIN_BUILD_MEMORY_MB" "$BUILD_MEMORY_POLL_SECONDS" -- \
  drop_priv_run "$PAPERCLIP_USER" -- env "${BUILD_ENV[@]}" \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$REPO_SRC" \
  "$NATIVE_DIR/scripts/build-release.sh" --commit "$COMMIT" --dest "$RELEASE_DIR" --repo-src "$REPO_SRC" \
  "${BUILD_EXCLUDE_ARGS[@]}"

log "== Restoring the data directory =="
if [[ -n "$DATA_SRC" ]]; then
  run "Copy $DATA_SRC into $ROOT/data" -- copy_tree "$DATA_SRC" "$ROOT/data"
  run "Own restored data as $PAPERCLIP_USER" -- chown -R "$PAPERCLIP_USER:$PAPERCLIP_USER" "$ROOT/data"
else
  log "No --data-src given; $ROOT/data starts empty (a brand-new instance)."
fi

log "== Point 'current' at the new release =="
run "Symlink $ROOT/current -> $RELEASE_DIR" -- ln -sfn "$RELEASE_DIR" "$ROOT/current"
run "Own the 'current' symlink as $PAPERCLIP_USER" -- chown -h "$PAPERCLIP_USER:$PAPERCLIP_USER" "$ROOT/current"

log "== Environment files under $ROOT/env (0600, owner $PAPERCLIP_USER) =="
seed_env_file() {
  local name="$1" override="$2"
  local dest="$ROOT/env/$name"
  if [[ -n "$override" ]]; then
    run "Install $name from the given file (contents not shown)" -- install -m 600 "$override" "$dest"
    run "Own $name as $PAPERCLIP_USER" -- chown "$PAPERCLIP_USER:$PAPERCLIP_USER" "$dest"
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] would seed $dest from the example template if it doesn't exist yet (never overwrite real secrets)"
    return 0
  fi
  if [[ -f "$dest" ]]; then
    log "$dest already exists, leaving it alone."
    return 0
  fi
  local example="$ZIMAOS_DIR/env/${name}.example"
  [[ -f "$example" ]] || example="$NATIVE_DIR/env/${name}.example"
  [[ -f "$example" ]] || { log "No template for $name, skipping."; return 0; }
  install -m 600 "$example" "$dest"
  sed -i "s#<root>#$ROOT#g" "$dest"
  chown "$PAPERCLIP_USER:$PAPERCLIP_USER" "$dest"
  log "Seeded $dest from the template (with <root> filled in as $ROOT)."
}
seed_env_file "paperclip-native.env" "$PAPERCLIP_ENV_FILE"
seed_env_file "telegram.env" "$TELEGRAM_ENV_FILE"
seed_env_file "rclone.env" "$RCLONE_ENV_FILE"

if [[ -n "$DATA_SRC" && "$DRY_RUN" != "1" ]]; then
  log "== Checking the restored data against the paths the installed env file actually resolves =="
  # Paperclip resolves its instance directory as
  # $PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID, and the secrets master
  # key lives wherever PAPERCLIP_SECRETS_MASTER_KEY_FILE points -- neither
  # is "$ROOT/data/db" or "$ROOT/data/secrets/master.key". Read the real
  # paths out of the env file this install actually wired up (the given
  # override, or the freshly seeded template) instead of guessing, so a
  # warning here points at a path the application actually reads.
  PAPERCLIP_HOME="" PAPERCLIP_INSTANCE_ID="default" PAPERCLIP_SECRETS_MASTER_KEY_FILE=""
  ENV_FILE_PATH="$ROOT/env/paperclip-native.env"
  if [[ -r "$ENV_FILE_PATH" ]]; then
    # shellcheck disable=SC1090
    source "$ENV_FILE_PATH"
  fi
  if [[ -n "$PAPERCLIP_HOME" ]]; then
    INSTANCE_DB_DIR="$PAPERCLIP_HOME/instances/${PAPERCLIP_INSTANCE_ID:-default}/db"
    [[ -d "$INSTANCE_DB_DIR" ]] || log "WARNING: $INSTANCE_DB_DIR not found after restore; embedded Postgres has no data yet."
  else
    log "WARNING: $ENV_FILE_PATH does not set PAPERCLIP_HOME; skipping the database-path check."
  fi
  if [[ -n "$PAPERCLIP_SECRETS_MASTER_KEY_FILE" ]]; then
    [[ -f "$PAPERCLIP_SECRETS_MASTER_KEY_FILE" ]] || log "WARNING: $PAPERCLIP_SECRETS_MASTER_KEY_FILE (PAPERCLIP_SECRETS_MASTER_KEY_FILE) not found after restore; secrets will not decrypt."
  else
    log "WARNING: $ENV_FILE_PATH does not set PAPERCLIP_SECRETS_MASTER_KEY_FILE; skipping the master-key check."
  fi
fi

log "== Recovery-path scripts: fixed location outside the release tree =="
# paperclip-watchdog.sh and telegram-alert.sh (and the lib/common.sh they
# source) must keep working even if $ROOT/current is broken or half-built
# -- that is the whole point of the rollback/alerting path, so they never
# live inside it. Prefer /usr/local/lib/paperclip if it is writable on this
# ZimaOS; fall back to <root>/recovery if not. Either way, never current/.
RECOVERY_BASE="/usr/local/lib/paperclip"
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would use /usr/local/lib/paperclip if writable, else $ROOT/recovery, for paperclip-watchdog.sh + telegram-alert.sh + paperclip-expo-idle-shutdown.sh + lib/common.sh"
  RECOVERY_BASE="<either /usr/local/lib/paperclip or $ROOT/recovery>"
else
  RECOVERY_BASE="$(resolve_recovery_base "/usr/local/lib/paperclip" "$ROOT/recovery")"
  if [[ "$RECOVERY_BASE" == "/usr/local/lib/paperclip" ]]; then
    log "/usr/local/lib/paperclip is writable; using it for recovery-path scripts."
  else
    log "/usr/local/lib/paperclip is not writable on this ZimaOS; using $RECOVERY_BASE instead."
  fi
  mkdir -p "$RECOVERY_BASE/scripts" "$RECOVERY_BASE/lib"
  for f in paperclip-watchdog.sh telegram-alert.sh paperclip-expo-idle-shutdown.sh; do
    install -m 755 "$NATIVE_DIR/scripts/$f" "$RECOVERY_BASE/scripts/$f"
  done
  install -m 644 "$NATIVE_DIR/lib/common.sh" "$RECOVERY_BASE/lib/common.sh"
fi

log "== Rendering the systemd units for this install (root=$ROOT, mount-path=$MOUNT_PATH, recovery-base=$RECOVERY_BASE) =="
# The checked-in unit files use the documented defaults as literal, concrete
# paths (so they are directly systemd-analyze-verifiable with no templating
# step). When --root / --mount-path / the detected recovery base differ
# from those defaults, retarget by substitution into a staging directory --
# never edit /etc/systemd/system in place before the ExecStart check below
# has run against the real paths this specific install will actually use.
DEFAULT_ROOT="/DATA/.media/External SSD/paperclip-native"
DEFAULT_MOUNT_PATH="/DATA/.media/External SSD"
DEFAULT_RECOVERY_BASE="/usr/local/lib/paperclip"
RENDERED_UNITS_DIR="$ROOT/logs/.rendered-units"
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would render $ZIMAOS_DIR/systemd/*.service and *.timer into a staging dir, substituting:"
  log "[dry-run]   '$DEFAULT_ROOT' -> '$ROOT'"
  log "[dry-run]   '$DEFAULT_MOUNT_PATH' -> '$MOUNT_PATH'"
  log "[dry-run]   '$DEFAULT_RECOVERY_BASE' -> '$RECOVERY_BASE'"
else
  mkdir -p "$RENDERED_UNITS_DIR"
  rm -f "$RENDERED_UNITS_DIR"/*.service "$RENDERED_UNITS_DIR"/*.timer
  for f in "$ZIMAOS_DIR"/systemd/*.service "$ZIMAOS_DIR"/systemd/*.timer; do
    sed -e "s#${DEFAULT_ROOT}#${ROOT}#g" \
        -e "s#${DEFAULT_MOUNT_PATH}#${MOUNT_PATH}#g" \
        -e "s#${DEFAULT_RECOVERY_BASE}#${RECOVERY_BASE}#g" \
        "$f" > "$RENDERED_UNITS_DIR/$(basename "$f")"
  done
fi

log "== Asserting every unit's ExecStart binary actually exists and is executable =="
# ZimaOS is not chrooted like the Debian route: "/" here already is the
# real, live filesystem, so the real target root to check against is "/"
# itself, not a fakeroot or a mounted image. Check the RENDERED units (the
# ones this install will actually run), not the checked-in defaults.
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would run: $NATIVE_DIR/scripts/check-execstart-targets.sh --root / --units-dir $RENDERED_UNITS_DIR"
else
  "$NATIVE_DIR/scripts/check-execstart-targets.sh" --root / --units-dir "$RENDERED_UNITS_DIR" \
    || die "ExecStart target check failed -- see the FAIL lines above. Fix the staged file before enabling units."
fi

log "== Installing the verified units (into /etc/systemd/system -- overlayfs rw, persistent) =="
run "Copy rendered unit files" -- bash -c "cp '$RENDERED_UNITS_DIR'/*.service '$RENDERED_UNITS_DIR'/*.timer /etc/systemd/system/"
run "Reload systemd unit files" -- systemctl daemon-reload

log "== Enabling units (not starting -- start paperclip-native.service explicitly once the env file is filled in) =="
UNITS_TO_ENABLE=(
  paperclip-native.service
  paperclip-native-backup.timer
  paperclip-native-watchdog.timer
  paperclip-native-vault-sync.timer
)
run "Enable units" -- systemctl enable "${UNITS_TO_ENABLE[@]}"

log "Done. $ROOT/current -> $RELEASE_DIR."
log "Fill in $ROOT/env/paperclip-native.env (BETTER_AUTH_SECRET at minimum), then:"
log "  systemctl start paperclip-native.service"
log "It listens on the PORT set in that env file (default 3101), alongside the Docker container on 3100."
