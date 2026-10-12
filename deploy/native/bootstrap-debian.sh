#!/usr/bin/env bash
# Install a minimal Debian 13 (trixie) onto the target SSD, so it can replace
# ZimaOS as the running system (TOM-130 option A). ZimaOS stays untouched on
# the eMMC as the way back.
#
# Run this from ZimaOS inside a temporary privileged container (it needs raw
# block-device access: partitioning, mkfs, chroot, grub-install, efibootmgr).
# Nothing here touches BootOrder; it only ever sets BootNext, so a plain
# power cycle after a failed boot drops straight back into ZimaOS.
#
# Usage:
#   bootstrap-debian.sh --ssd-model <model> --ssd-serial <serial> \
#     --hdd-model <model> --hdd-serial <serial> \
#     --ssh-keys-file <path> [--hostname <name>] [--force] [--dry-run]
#
# The SSD is identified by model and/or serial substring match against
# `lsblk`, never by sdX/nvmeX name -- adding a second drive can renumber
# those. At least one of --ssd-model / --ssd-serial is required, same for
# the HDD. The HDD is expected to already hold a filesystem (it is only
# resolved for its UUID, never formatted by this script).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

DRY_RUN=0
FORCE=0
SSD_MODEL=""
SSD_SERIAL=""
HDD_MODEL=""
HDD_SERIAL=""
SSH_KEYS_FILE=""
HOSTNAME_VALUE="paperclip-native"
SUITE="trixie"
MIRROR="http://deb.debian.org/debian"
ESP_SIZE_MIB=512
ROOT_MOUNT="/mnt/paperclip-root"

BASE_PACKAGES=(
  openssh-server sudo chrony unattended-upgrades ca-certificates gnupg
  rclone git curl jq build-essential wakeonlan
  linux-image-amd64 grub-efi-amd64 efibootmgr dosfstools
)

# tailscale and cloudflared are not in Debian's own archive; they ship from
# their own vendor apt repos (pkgs.tailscale.com, pkg.cloudflare.com). They
# are installed in a separate step, after those repos are added, so a
# missing/renamed suite there fails on its own with a clear message instead
# of aborting the whole BASE_PACKAGES install.
VENDOR_PACKAGES=(tailscale cloudflared)

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssd-model) SSD_MODEL="$2"; shift 2 ;;
    --ssd-serial) SSD_SERIAL="$2"; shift 2 ;;
    --hdd-model) HDD_MODEL="$2"; shift 2 ;;
    --hdd-serial) HDD_SERIAL="$2"; shift 2 ;;
    --ssh-keys-file) SSH_KEYS_FILE="$2"; shift 2 ;;
    --hostname) HOSTNAME_VALUE="$2"; shift 2 ;;
    --mirror) MIRROR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$SSD_MODEL" || -n "$SSD_SERIAL" ]] || die "Give --ssd-model and/or --ssd-serial to identify the target SSD."
[[ -n "$HDD_MODEL" || -n "$HDD_SERIAL" ]] || die "Give --hdd-model and/or --hdd-serial to identify the data HDD."
[[ -n "$SSH_KEYS_FILE" ]] || die "Give --ssh-keys-file with the authorized_keys content to install (no keys are copied from ZimaOS)."
if [[ "$DRY_RUN" != "1" ]]; then
  [[ -r "$SSH_KEYS_FILE" ]] || die "--ssh-keys-file '$SSH_KEYS_FILE' is not readable."
fi

if [[ "$DRY_RUN" != "1" ]]; then
  require_root
  require_cmd lsblk parted mkfs.vfat mkfs.ext4 debootstrap chroot blkid python3 efibootmgr
fi

log "Resolving target disks by model/serial (never by sdX name)..."
SSD_DEV="$(resolve_or_placeholder "<ssd-dev matching model='$SSD_MODEL' serial='$SSD_SERIAL'>" \
  resolve_disk_by_model_serial "$SSD_MODEL" "$SSD_SERIAL")"
HDD_DEV="$(resolve_or_placeholder "<hdd-dev matching model='$HDD_MODEL' serial='$HDD_SERIAL'>" \
  resolve_disk_by_model_serial "$HDD_MODEL" "$HDD_SERIAL")"
log "SSD: $SSD_DEV"
log "HDD: $HDD_DEV (not formatted; only its UUID is used for fstab)"

if [[ "$DRY_RUN" != "1" ]]; then
  if disk_has_partitions "$SSD_DEV" && [[ "$FORCE" != "1" ]]; then
    die "$SSD_DEV already has partitions. Re-run with --force to wipe and repartition it, or pick the right disk."
  fi
else
  log "[dry-run] would refuse to continue if $SSD_DEV already has partitions, unless --force was given (force=$FORCE)"
fi

ESP_PART="${SSD_DEV}1"
ROOT_PART="${SSD_DEV}2"
# NVMe-style device names need a 'p' before the partition number; SATA (sdX)
# devices do not. Only matters for the real run -- the dry-run placeholder
# path never reaches here with a real device name.
if [[ "$DRY_RUN" != "1" && "$SSD_DEV" =~ nvme ]]; then
  ESP_PART="${SSD_DEV}p1"
  ROOT_PART="${SSD_DEV}p2"
fi

log "== Partitioning $SSD_DEV: GPT, ${ESP_SIZE_MIB}MiB ESP + ext4 root =="
run "Wipe existing partition table on $SSD_DEV" -- parted --script "$SSD_DEV" mklabel gpt
run "Create ESP partition (1MiB-${ESP_SIZE_MIB}MiB, boot+esp flags)" -- \
  parted --script "$SSD_DEV" mkpart ESP fat32 1MiB "${ESP_SIZE_MIB}MiB"
run "Set esp/boot flags on partition 1" -- parted --script "$SSD_DEV" set 1 esp on
run "Create root partition (${ESP_SIZE_MIB}MiB-100%)" -- \
  parted --script "$SSD_DEV" mkpart root ext4 "${ESP_SIZE_MIB}MiB" 100%
run "Wait for the kernel to see the new partitions" -- partprobe "$SSD_DEV"

log "== Formatting =="
run "Format ESP ($ESP_PART) as FAT32" -- mkfs.vfat -F32 -n ESP "$ESP_PART"
run "Format root ($ROOT_PART) as ext4" -- mkfs.ext4 -F -L paperclip-root "$ROOT_PART"

log "== Mounting target and running debootstrap $SUITE =="
run "Create mount point $ROOT_MOUNT" -- mkdir -p "$ROOT_MOUNT"
run "Mount root partition" -- mount "$ROOT_PART" "$ROOT_MOUNT"
run "Create ESP mount point" -- mkdir -p "$ROOT_MOUNT/boot/efi"
run "Mount ESP partition" -- mount "$ESP_PART" "$ROOT_MOUNT/boot/efi"
run "debootstrap $SUITE from $MIRROR" -- \
  debootstrap --arch=amd64 "$SUITE" "$ROOT_MOUNT" "$MIRROR"

ROOT_UUID="$(resolve_or_placeholder "<uuid-of-$ROOT_PART>" blkid -s UUID -o value "$ROOT_PART")"
ESP_UUID="$(resolve_or_placeholder "<uuid-of-$ESP_PART>" blkid -s UUID -o value "$ESP_PART")"
HDD_UUID="$(resolve_or_placeholder "<uuid-of-$HDD_DEV-filesystem>" blkid -s UUID -o value "${HDD_DEV}1")"

log "== Writing /etc/fstab by UUID (SSD root, HDD at /srv/hdd with nofail) =="
FSTAB_CONTENT="# Generated by bootstrap-debian.sh -- do not edit by sdX/nvmeX name, disks reorder.
UUID=$ROOT_UUID /            ext4   defaults,noatime         0 1
UUID=$ESP_UUID  /boot/efi    vfat   umask=0077               0 1
UUID=$HDD_UUID  /srv/hdd     ext4   defaults,nofail,noatime  0 2
"
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would write $ROOT_MOUNT/etc/fstab:"
  printf '%s' "$FSTAB_CONTENT" | sed 's/^/[dry-run]   /'
else
  log "Writing $ROOT_MOUNT/etc/fstab"
  printf '%s' "$FSTAB_CONTENT" > "$ROOT_MOUNT/etc/fstab"
  run "Create /srv/hdd mount point in target" -- mkdir -p "$ROOT_MOUNT/srv/hdd"
fi

log "== Hostname and SSH keys (no keys copied from ZimaOS) =="
run "Set hostname to $HOSTNAME_VALUE" -- bash -c "echo '$HOSTNAME_VALUE' > '$ROOT_MOUNT/etc/hostname'"
run "Create /root/.ssh in target" -- mkdir -p -m 700 "$ROOT_MOUNT/root/.ssh"
run "Install authorized_keys from $SSH_KEYS_FILE" -- bash -c \
  "install -m 600 '$SSH_KEYS_FILE' '$ROOT_MOUNT/root/.ssh/authorized_keys'"

log "== Binding /dev /proc /sys /run for chroot =="
for d in dev proc sys run; do
  run "Bind-mount /$d into target" -- mount --bind "/$d" "$ROOT_MOUNT/$d"
done

log "== Base packages, vendor repos, GRUB, SSH/password policy (inside chroot) =="
CHROOT_SCRIPT="$(cat <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

log() { printf '[chroot] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

log "Installing Debian-native base packages..."
apt-get update
apt-get install -y --no-install-recommends BASE_PACKAGES_PLACEHOLDER

log "Adding the Tailscale apt repository (pkgs.tailscale.com, suite=SUITE_PLACEHOLDER)..."
install -d -m 755 /usr/share/keyrings
curl -fsSL "https://pkgs.tailscale.com/stable/debian/SUITE_PLACEHOLDER.noarmor.gpg" \
  -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
  || die "Could not fetch the Tailscale signing key for suite 'SUITE_PLACEHOLDER' from pkgs.tailscale.com. Check that suite is listed at https://pkgs.tailscale.com/stable/debian/."
curl -fsSL "https://pkgs.tailscale.com/stable/debian/SUITE_PLACEHOLDER.tailscale-keyring.list" \
  -o /etc/apt/sources.list.d/tailscale.list \
  || die "Could not fetch the Tailscale apt source list for suite 'SUITE_PLACEHOLDER' from pkgs.tailscale.com."

log "Adding the Cloudflare apt repository (pkg.cloudflare.com, suite=SUITE_PLACEHOLDER)..."
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  -o /usr/share/keyrings/cloudflare-main.gpg \
  || die "Could not fetch the Cloudflare signing key from pkg.cloudflare.com."
printf 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared SUITE_PLACEHOLDER main\n' \
  > /etc/apt/sources.list.d/cloudflared.list

log "Installing tailscale and cloudflared from their vendor repositories..."
apt-get update || die "apt-get update failed after adding the Tailscale/Cloudflare apt repositories."
apt-get install -y --no-install-recommends VENDOR_PACKAGES_PLACEHOLDER \
  || die "Installing VENDOR_PACKAGES_PLACEHOLDER from their vendor repositories failed. Check that suite 'SUITE_PLACEHOLDER' is supported by pkgs.tailscale.com and pkg.cloudflare.com."

sed -ri 's/^#?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -ri 's/^#?PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl enable ssh chrony tailscaled fstrim.timer unattended-upgrades

# --no-nvram (not --removable): --removable installs only the fallback
# \EFI\BOOT\BOOTX64.EFI path and never creates \EFI\debian\grubx64.efi, which
# is the exact loader path the UEFI boot entry below points at. Without
# --removable, --bootloader-id=debian creates \EFI\debian\grubx64.efi, and we
# additionally copy it to \EFI\BOOT\BOOTX64.EFI ourselves as a fallback for
# firmware that ignores NVRAM boot entries.
grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=debian --no-nvram
[[ -f /boot/efi/EFI/debian/grubx64.efi ]] \
  || die "grub-install did not produce /boot/efi/EFI/debian/grubx64.efi -- refusing to continue, the UEFI boot entry would point at a missing loader."
mkdir -p /boot/efi/EFI/BOOT
cp /boot/efi/EFI/debian/grubx64.efi /boot/efi/EFI/BOOT/BOOTX64.EFI
update-grub
EOS
)"
CHROOT_SCRIPT="${CHROOT_SCRIPT/BASE_PACKAGES_PLACEHOLDER/${BASE_PACKAGES[*]}}"
CHROOT_SCRIPT="${CHROOT_SCRIPT//SUITE_PLACEHOLDER/$SUITE}"
CHROOT_SCRIPT="${CHROOT_SCRIPT//VENDOR_PACKAGES_PLACEHOLDER/${VENDOR_PACKAGES[*]}}"
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would chroot into $ROOT_MOUNT and run via /bin/bash (interpreter line shown below):"
  printf '%s\n' "$CHROOT_SCRIPT" | sed 's/^/[dry-run]   /'
else
  printf '%s' "$CHROOT_SCRIPT" > "$ROOT_MOUNT/tmp/bootstrap-chroot.sh"
  chmod +x "$ROOT_MOUNT/tmp/bootstrap-chroot.sh"
  # Without a bash shebang, chroot's exec falls back to the target's /bin/sh
  # (dash on Debian), which has no [[ -- the script would fail with
  # "[[: not found" partway through. Fail loudly here instead.
  [[ "$(head -n1 "$ROOT_MOUNT/tmp/bootstrap-chroot.sh")" == "#!/usr/bin/env bash" ]] \
    || die "Generated chroot script at $ROOT_MOUNT/tmp/bootstrap-chroot.sh has no bash shebang as its first line -- refusing to run it."
  run "Run base-package/GRUB setup inside chroot" -- chroot "$ROOT_MOUNT" /bin/bash /tmp/bootstrap-chroot.sh
  rm -f "$ROOT_MOUNT/tmp/bootstrap-chroot.sh"
fi

log "== Verifying the GRUB loader exists on the ESP before creating a UEFI entry for it =="
GRUB_LOADER_PATH="$ROOT_MOUNT/boot/efi/EFI/debian/grubx64.efi"
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would assert $GRUB_LOADER_PATH exists before calling efibootmgr --create, and fail loudly if it does not"
else
  [[ -f "$GRUB_LOADER_PATH" ]] \
    || die "$GRUB_LOADER_PATH is missing after grub-install. Refusing to create a UEFI boot entry that would point at a loader that does not exist."
  log "Confirmed: $GRUB_LOADER_PATH exists."
fi

log "== UEFI boot entry: BootNext only, BootOrder is never touched =="
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would record the current BootOrder, add a 'debian' UEFI boot entry on $SSD_DEV,"
  log "[dry-run] restore BootOrder to its original value if the new entry changed it, then set"
  log "[dry-run] BootNext to the new entry so only the *next* boot tries Debian. Default stays ZimaOS."
else
  ORIGINAL_BOOTORDER="$(efibootmgr | awk -F': ' '/^BootOrder/{print $2}')"
  log "Captured original BootOrder: $ORIGINAL_BOOTORDER"
  efibootmgr --create --disk "$SSD_DEV" --part 1 \
    --label "debian-native" --loader '\EFI\debian\grubx64.efi' >/dev/null
  NEW_BOOTNUM="$(efibootmgr | awk -F'[ *]' '/debian-native/{sub("Boot","",$1); print $1; exit}')"
  [[ -n "$NEW_BOOTNUM" ]] || die "Could not find the Boot#### entry we just created for 'debian-native'."
  if [[ -n "$ORIGINAL_BOOTORDER" ]]; then
    log "Restoring BootOrder to $ORIGINAL_BOOTORDER (the new entry must not become the default)"
    efibootmgr -o "$ORIGINAL_BOOTORDER" >/dev/null
  fi
  log "Setting BootNext=$NEW_BOOTNUM (one-time only)"
  efibootmgr -n "$NEW_BOOTNUM" >/dev/null
fi

log "== Cleanup =="
for d in run sys proc dev; do
  run "Unmount /$d from target" -- umount "$ROOT_MOUNT/$d"
done
run "Unmount ESP" -- umount "$ROOT_MOUNT/boot/efi"
run "Unmount root" -- umount "$ROOT_MOUNT"

log "Done. Power-cycle the board to try Debian once (BootNext). A failed boot or a second"
log "power cycle returns to ZimaOS, because BootOrder was never changed."
