#!/usr/bin/env bash
# Pre-stage a full Paperclip install onto the SSD target *before* the first
# reboot into Debian (TOM-130/TOM-202 cutover). Run this on the ZimaOS side,
# against the SSD bootstrap-debian.sh already partitioned and debootstrapped
# (it mounts and unmounts the target itself; bootstrap-debian.sh leaves it
# unmounted when it finishes).
#
# The moment the board boots Debian, the Paperclip container, Hermes and the
# lab-claude-remote session all stay behind on ZimaOS -- there is no agent
# left on the box to run install-paperclip.sh, fill in env files, or start
# units by hand. So this script does all of that here, first, from ZimaOS:
# it builds the release, restores the data directory, writes the real env
# files, carries over the Tailscale/Cloudflare identities, installs the
# systemd units and enables them inside the target root. After this script
# finishes, the SSD is a system that comes up serving Paperclip on its own.
#
# Why build inside a chroot of the target, not on the ZimaOS host: the
# release's native Node modules and the embedded Postgres binary are built
# against the running system's glibc/Node ABI. Building on ZimaOS and
# copying the result risks an ABI mismatch against Debian trixie; building
# inside a chroot of the target root guarantees the binary matches the
# system it will actually run on -- the same reasoning bootstrap-debian.sh
# already uses for its own base-package/GRUB chroot step.
#
# Usage:
#   prestage-paperclip.sh --ssd-model <model> --ssd-serial <serial> \
#     --commit <sha> --repo-src <path> --data-src <path> \
#     --paperclip-env-file <path> \
#     [--telegram-env-file <path>] [--notes-vault-bridge-env-file <path>] \
#     [--rclone-env-file <path>] \
#     [--tailscale-state-file <path>] [--cloudflared-dir <path>] \
#     [--repo-url <url>] [--dry-run]
#
# Every *-env-file / *-state-file / --cloudflared-dir value must be a file
# or directory PATH, never a literal secret: this script only ever copies
# files byte-for-byte, and never prints their contents (not even under
# --dry-run, which only names the paths it would copy).
#
# --tailscale-state-file and --cloudflared-dir carry the Tailscale node
# identity and Cloudflare tunnel credentials over from ZimaOS so the board
# keeps the same addresses after the move -- no re-authentication needed.
# TOM-203 reports their exact paths on the live ZimaOS host. If omitted,
# tailscaled/cloudflared come up with no identity and need manual
# (re-)authentication after first boot.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

DRY_RUN=0
SSD_MODEL=""
SSD_SERIAL=""
COMMIT=""
REPO_SRC=""
REPO_URL="https://github.com/TomMcCall12/toms-lab.git"
DATA_SRC=""
PAPERCLIP_ENV_FILE=""
TELEGRAM_ENV_FILE=""
NOTES_VAULT_BRIDGE_ENV_FILE=""
RCLONE_ENV_FILE=""
TAILSCALE_STATE_FILE=""
CLOUDFLARED_DIR=""
ROOT_MOUNT="/mnt/paperclip-root"
NODE_MAJOR="24"
REPO_SRC_IN_CHROOT="/mnt/zimaos-repo"

UNITS_TO_ENABLE=(
  paperclip.service
  paperclip-notes-vault-bridge.service
  paperclip-backup.timer
  paperclip-watchdog.timer
  vault-drive-sync.timer
  paperclip-firstboot.service
)

usage() {
  sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssd-model) SSD_MODEL="$2"; shift 2 ;;
    --ssd-serial) SSD_SERIAL="$2"; shift 2 ;;
    --commit) COMMIT="$2"; shift 2 ;;
    --repo-src) REPO_SRC="$2"; shift 2 ;;
    --repo-url) REPO_URL="$2"; shift 2 ;;
    --data-src) DATA_SRC="$2"; shift 2 ;;
    --paperclip-env-file) PAPERCLIP_ENV_FILE="$2"; shift 2 ;;
    --telegram-env-file) TELEGRAM_ENV_FILE="$2"; shift 2 ;;
    --notes-vault-bridge-env-file) NOTES_VAULT_BRIDGE_ENV_FILE="$2"; shift 2 ;;
    --rclone-env-file) RCLONE_ENV_FILE="$2"; shift 2 ;;
    --tailscale-state-file) TAILSCALE_STATE_FILE="$2"; shift 2 ;;
    --cloudflared-dir) CLOUDFLARED_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$SSD_MODEL" || -n "$SSD_SERIAL" ]] || die "Give --ssd-model and/or --ssd-serial to identify the target SSD (the same one bootstrap-debian.sh used)."
[[ -n "$COMMIT" ]] || die "Give --commit <sha> (the exact live commit to build)."
[[ "$COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || die "--commit must be a hex git sha (got: $COMMIT)"
[[ -n "$REPO_SRC" ]] || die "Give --repo-src <path> -- a local checkout to mirror from. The target holds no GitHub credential yet, and TomMcCall12/toms-lab is private; see README.md."
[[ -n "$DATA_SRC" ]] || die "Give --data-src <path> to restore the data directory from."
[[ -n "$PAPERCLIP_ENV_FILE" ]] || die "Give --paperclip-env-file <path> (a filled-in copy of env/paperclip.env.example; pass a file path, never the values themselves)."

if [[ "$DRY_RUN" != "1" ]]; then
  require_root
  require_cmd lsblk blkid mount umount chroot runuser rsync git corepack systemctl
  [[ -d "$REPO_SRC" ]] || die "--repo-src '$REPO_SRC' is not a directory."
  [[ -d "$DATA_SRC" ]] || die "--data-src '$DATA_SRC' is not a directory."
  [[ -r "$PAPERCLIP_ENV_FILE" ]] || die "--paperclip-env-file '$PAPERCLIP_ENV_FILE' is not readable."
  for f in "$TELEGRAM_ENV_FILE" "$NOTES_VAULT_BRIDGE_ENV_FILE" "$RCLONE_ENV_FILE" "$TAILSCALE_STATE_FILE"; do
    [[ -z "$f" || -r "$f" ]] || die "'$f' is not readable."
  done
  [[ -z "$CLOUDFLARED_DIR" || -d "$CLOUDFLARED_DIR" ]] || die "--cloudflared-dir '$CLOUDFLARED_DIR' is not a directory."
fi

log "Resolving target SSD by model/serial (never by sdX name)..."
SSD_DEV="$(resolve_or_placeholder "<ssd-dev matching model='$SSD_MODEL' serial='$SSD_SERIAL'>" \
  resolve_disk_by_model_serial "$SSD_MODEL" "$SSD_SERIAL")"
log "SSD: $SSD_DEV"

ESP_PART="${SSD_DEV}1"
ROOT_PART="${SSD_DEV}2"
if [[ "$DRY_RUN" != "1" && "$SSD_DEV" =~ nvme ]]; then
  ESP_PART="${SSD_DEV}p1"
  ROOT_PART="${SSD_DEV}p2"
fi

cleanup() {
  [[ "$DRY_RUN" == "1" ]] && return 0
  log "== Cleanup: unmounting the target =="
  mountpoint -q "$ROOT_MOUNT$REPO_SRC_IN_CHROOT" 2>/dev/null && umount "$ROOT_MOUNT$REPO_SRC_IN_CHROOT"
  local d
  for d in run sys proc dev; do
    mountpoint -q "$ROOT_MOUNT/$d" 2>/dev/null && umount "$ROOT_MOUNT/$d"
  done
  mountpoint -q "$ROOT_MOUNT/boot/efi" 2>/dev/null && umount "$ROOT_MOUNT/boot/efi"
  mountpoint -q "$ROOT_MOUNT" 2>/dev/null && umount "$ROOT_MOUNT"
}
trap cleanup EXIT

log "== Mounting the target root and ESP (bootstrap-debian.sh leaves them unmounted) =="
run "Create mount point $ROOT_MOUNT" -- mkdir -p "$ROOT_MOUNT"
run "Mount root partition" -- mount "$ROOT_PART" "$ROOT_MOUNT"
run "Mount ESP partition" -- mount "$ESP_PART" "$ROOT_MOUNT/boot/efi"

log "== Binding /dev /proc /sys /run and the local repo checkout for the build chroot =="
for d in dev proc sys run; do
  run "Bind-mount /$d into target" -- mount --bind "/$d" "$ROOT_MOUNT/$d"
done
run "Create $REPO_SRC_IN_CHROOT inside the target" -- mkdir -p "$ROOT_MOUNT$REPO_SRC_IN_CHROOT"
# A single `mount --bind -o ro` does not actually enforce read-only (that
# option is silently dropped for a plain bind mount on Linux); a bind mount
# only becomes read-only via a second remount pass.
run "Bind-mount $REPO_SRC into the chroot at $REPO_SRC_IN_CHROOT" -- \
  mount --bind "$REPO_SRC" "$ROOT_MOUNT$REPO_SRC_IN_CHROOT"
run "Remount $REPO_SRC_IN_CHROOT read-only" -- \
  mount -o remount,bind,ro "$ROOT_MOUNT$REPO_SRC_IN_CHROOT"

log "== Creating the paperclip system user and building commit $COMMIT inside the chroot =="
CHROOT_BUILD_SCRIPT="$(cat <<EOS
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

log() { printf '[chroot] %s\n' "\$*" >&2; }
die() { log "ERROR: \$*"; exit 1; }

if ! getent group paperclip >/dev/null; then groupadd --system paperclip; fi
if ! getent passwd paperclip >/dev/null; then
  useradd --system --gid paperclip --home-dir /srv/paperclip --shell /usr/sbin/nologin --create-home paperclip
fi
mkdir -p /srv/paperclip/releases /srv/paperclip/data /srv/paperclip/env /srv/hdd
chown -R paperclip:paperclip /srv/paperclip
chown paperclip:paperclip /srv/hdd

CURRENT_NODE_MAJOR="\$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [[ "\$CURRENT_NODE_MAJOR" != "$NODE_MAJOR" ]]; then
  log "Installing Node $NODE_MAJOR via NodeSource..."
  curl -fsSL -o /tmp/nodesource_setup.sh "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" \
    || die "Could not fetch the NodeSource setup script for Node $NODE_MAJOR.x."
  bash /tmp/nodesource_setup.sh
  apt-get install -y nodejs
  rm -f /tmp/nodesource_setup.sh
fi

log "Building release $COMMIT from the local checkout at $REPO_SRC_IN_CHROOT..."
# $REPO_SRC_IN_CHROOT is a read-only bind mount owned by root; the build runs
# as paperclip, so git would otherwise refuse it as a "dubious ownership"
# repository. Trust that one path for this build process only -- never chown
# the source, write a global/system git config, or remount it writable.
runuser -u paperclip -- env \
  GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=safe.directory \
  GIT_CONFIG_VALUE_0="$REPO_SRC_IN_CHROOT" \
  "$REPO_SRC_IN_CHROOT/deploy/native/scripts/build-release.sh" \
  --commit "$COMMIT" --dest "/srv/paperclip/releases/$COMMIT" --repo-src "$REPO_SRC_IN_CHROOT" \
  || die "build-release.sh failed for commit $COMMIT."
ln -sfn "/srv/paperclip/releases/$COMMIT" /srv/paperclip/current
chown -h paperclip:paperclip /srv/paperclip/current

# The mirror's origin now points at the read-only bind-mounted ZimaOS repo
# checkout, which will not exist once this script unmounts it and ZimaOS is
# retired. Point it back at GitHub for later deploys (they will need their
# own credential by then -- see README.md -- but origin should name the real
# repository, not a path that stops existing after today).
git -C /srv/paperclip/releases/.git-mirror.git remote set-url origin "$REPO_URL"
EOS
)"

if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would chroot into $ROOT_MOUNT and run via /bin/bash (interpreter line shown below):"
  printf '%s\n' "$CHROOT_BUILD_SCRIPT" | sed 's/^/[dry-run]   /'
else
  printf '%s' "$CHROOT_BUILD_SCRIPT" > "$ROOT_MOUNT/tmp/prestage-build.sh"
  chmod +x "$ROOT_MOUNT/tmp/prestage-build.sh"
  # Without a bash shebang, chroot's exec falls back to the target's /bin/sh
  # (dash on Debian), which has no [[ -- the script would fail with
  # "[[: not found" partway through. Fail loudly here instead.
  [[ "$(head -n1 "$ROOT_MOUNT/tmp/prestage-build.sh")" == "#!/usr/bin/env bash" ]] \
    || die "Generated chroot build script at $ROOT_MOUNT/tmp/prestage-build.sh has no bash shebang as its first line -- refusing to run it."
  run "Build release $COMMIT inside the target chroot" -- chroot "$ROOT_MOUNT" /bin/bash /tmp/prestage-build.sh
  rm -f "$ROOT_MOUNT/tmp/prestage-build.sh"
fi

log "== Restoring the data directory from $DATA_SRC =="
run "Copy $DATA_SRC into the target's /srv/paperclip/data" -- \
  rsync -a "$DATA_SRC"/ "$ROOT_MOUNT/srv/paperclip/data/"
run "Own the restored data as paperclip (inside the target)" -- \
  chroot "$ROOT_MOUNT" chown -R paperclip:paperclip /srv/paperclip/data
if [[ "$DRY_RUN" != "1" ]]; then
  [[ -d "$ROOT_MOUNT/srv/paperclip/data/db" ]] \
    || log "WARNING: /srv/paperclip/data/db not found after restore; embedded Postgres has no data yet."
  [[ -f "$ROOT_MOUNT/srv/paperclip/data/secrets/master.key" ]] \
    || log "WARNING: /srv/paperclip/data/secrets/master.key not found after restore; secrets will not decrypt."
else
  log "[dry-run] would warn if /srv/paperclip/data/db or /srv/paperclip/data/secrets/master.key are missing after restore"
fi

log "== Writing the real env files (copied byte-for-byte; values are never printed or logged) =="
install_env_file() {
  local src="$1" name="$2"
  if [[ -z "$src" ]]; then
    local example="$NATIVE_DIR/env/${name}.example"
    if [[ "$DRY_RUN" == "1" ]]; then
      log "[dry-run] no --*-env-file given for $name; would seed $example as a placeholder instead"
    else
      install -m 600 "$example" "$ROOT_MOUNT/srv/paperclip/env/$name"
      log "No real $name given; seeded the placeholder template (fill it in and restart paperclip.service before relying on it)."
    fi
    return 0
  fi
  run "Install $name from the given file (contents not shown)" -- \
    install -m 600 "$src" "$ROOT_MOUNT/srv/paperclip/env/$name"
}
run "Create /srv/paperclip/env in the target" -- mkdir -p "$ROOT_MOUNT/srv/paperclip/env"
install_env_file "$PAPERCLIP_ENV_FILE" "paperclip.env"
install_env_file "$TELEGRAM_ENV_FILE" "telegram.env"
install_env_file "$NOTES_VAULT_BRIDGE_ENV_FILE" "notes-vault-bridge.env"
install_env_file "$RCLONE_ENV_FILE" "rclone.env"
run "Own /srv/paperclip/env as paperclip (inside the target)" -- \
  chroot "$ROOT_MOUNT" chown -R paperclip:paperclip /srv/paperclip/env

log "== Carrying over the Tailscale node identity and Cloudflare tunnel credentials =="
if [[ -n "$TAILSCALE_STATE_FILE" ]]; then
  run "Create /var/lib/tailscale in the target" -- mkdir -p "$ROOT_MOUNT/var/lib/tailscale"
  run "Carry over the Tailscale node state (keeps the same Tailscale identity/IP; no re-authentication)" -- \
    install -m 600 "$TAILSCALE_STATE_FILE" "$ROOT_MOUNT/var/lib/tailscale/tailscaled.state"
else
  log "No --tailscale-state-file given; tailscaled will register as a brand-new node on first boot (re-authentication needed)."
fi
if [[ -n "$CLOUDFLARED_DIR" ]]; then
  run "Create /etc/cloudflared in the target" -- mkdir -p "$ROOT_MOUNT/etc/cloudflared"
  run "Carry over the Cloudflare tunnel credentials directory (keeps the same tunnel identity; no re-authentication)" -- \
    rsync -a "$CLOUDFLARED_DIR"/ "$ROOT_MOUNT/etc/cloudflared/"
else
  log "No --cloudflared-dir given; cloudflared will have no tunnel credentials until you provide them."
fi

log "== Installing recovery-path scripts outside the release tree =="
# paperclip-firstboot.sh, paperclip-watchdog.sh and telegram-alert.sh must
# keep working even if the release at /srv/paperclip/current is broken or
# half-built -- that is the whole point of the unattended rollback. So they
# (and the lib/common.sh they source) live at a fixed location the release
# symlink never touches, not inside it. The scripts/ + lib/ layout is
# mirrored here unchanged so each script's existing
# "$SCRIPT_DIR/../lib/common.sh" source line keeps resolving correctly.
RECOVERY_SCRIPTS=(paperclip-firstboot.sh paperclip-watchdog.sh telegram-alert.sh)
run "Create /usr/local/lib/paperclip/{scripts,lib} in the target" -- \
  mkdir -p "$ROOT_MOUNT/usr/local/lib/paperclip/scripts" "$ROOT_MOUNT/usr/local/lib/paperclip/lib"
for f in "${RECOVERY_SCRIPTS[@]}"; do
  run "Install $f to the fixed recovery-script location" -- \
    install -m 755 "$NATIVE_DIR/scripts/$f" "$ROOT_MOUNT/usr/local/lib/paperclip/scripts/$f"
done
run "Install lib/common.sh to the fixed recovery-script location" -- \
  install -m 644 "$NATIVE_DIR/lib/common.sh" "$ROOT_MOUNT/usr/local/lib/paperclip/lib/common.sh"

log "== Installing and enabling the systemd units inside the target (offline, no boot required) =="
run "Copy unit files into the target" -- bash -c \
  "cp '$NATIVE_DIR'/systemd/*.service '$NATIVE_DIR'/systemd/*.timer '$ROOT_MOUNT/etc/systemd/system/'"
run "Enable units in the target root" -- \
  systemctl --root="$ROOT_MOUNT" enable "${UNITS_TO_ENABLE[@]}"

log "== Asserting every unit's ExecStart binary actually exists and is executable in the target =="
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would run: $SCRIPT_DIR/check-execstart-targets.sh --root $ROOT_MOUNT --units-dir $NATIVE_DIR/systemd"
else
  "$SCRIPT_DIR/check-execstart-targets.sh" --root "$ROOT_MOUNT" --units-dir "$NATIVE_DIR/systemd" \
    || die "ExecStart target check failed -- see the FAIL lines above. A unit would fail instantly on boot; fix the staged file before rebooting the target."
fi

log "Done. $ROOT_MOUNT (the SSD) now boots straight into a Paperclip install that serves itself:"
log "release $COMMIT is 'current', the data directory is restored, env files and identities are in"
log "place, and every unit is enabled. Power-cycle to try it (BootNext only; a failed first boot"
log "reports its outcome to $ROOT_MOUNT/boot/efi/paperclip-firstboot-status.txt and reboots back to ZimaOS)."
