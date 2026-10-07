# Native Debian deploy (TOM-130 / TOM-133)

Repeatable scripts that replace ZimaOS + Docker + Hermes with a minimal
Debian 13 (trixie) running Paperclip directly, on the new Lexar NS100 SSD.
ZimaOS stays untouched on the eMMC as the way back. See the TOM-130 `plan`
and `hermes-inventory` issue documents for the full migration plan; this
file covers only the mechanics of the scripts in this directory.

**Nothing in this directory has been run against real hardware yet.** Every
script has a `--dry-run` that prints its plan without touching disks,
services, or data.

## What's here

| Path | Purpose |
|---|---|
| `bootstrap-debian.sh` | Partitions the SSD, debootstraps trixie, writes fstab by UUID, installs GRUB + base packages, sets a one-time UEFI `BootNext`. Run from ZimaOS inside a temporary privileged container. |
| `install-paperclip.sh` | Creates the `paperclip` system user, the `/srv/paperclip` release layout, installs Node 24 + pnpm, builds the given commit, restores the data directory. Run on the booted Debian system. |
| `paperclip-deploy` | Native `report` / `status` / `deploy <commit>` commands, usable as an SSH forced command. Deploy = DB snapshot, build, switch `current`, restart, health check, automatic rollback. |
| `systemd/` | Unit files: `paperclip.service`, `paperclip-notes-vault-bridge.service`, backup/watchdog/vault-sync timers + services, and the `paperclip-alert@.service` Telegram template every timer's `OnFailure=` points at. |
| `scripts/` | Helpers invoked by the units above (`paperclip-backup.sh`, `paperclip-watchdog.sh`, `vault-drive-sync.sh`, `telegram-alert.sh`), the shared release builder (`build-release.sh`), and a repeatable `systemd-analyze verify` check (`verify-systemd-units.sh`). |
| `env/*.env.example` | Templates for the env files under `/srv/paperclip/env/`. Copy, fill in, never commit the real files. |
| `lib/common.sh` | Shared logging/dry-run/retry helpers sourced by every script. |

## Before migration day

1. Fit the Lexar NS100 SSD (do not remove the eMMC or the existing HDD).
2. Confirm the SSD's model/serial with `lsblk -o NAME,MODEL,SERIAL,SIZE` from
   ZimaOS -- `bootstrap-debian.sh` identifies disks by model/serial, never
   by `sdX` name.
3. Prepare an `authorized_keys`-format file with the SSH keys that should
   have access to the new system. No keys are copied from ZimaOS.
4. Take the Phase 1 backups from the TOM-130 plan (DB dump, data directory,
   vault, Hermes configs) and confirm the restore drill passed.
5. Dry-run every script once and read the output (see "Dry run everything"
   below).

## Migration day, in order

Run `bootstrap-debian.sh` and `install-paperclip.sh` for real only once the
dry runs below have been reviewed.

1. **Bootstrap Debian onto the SSD** (from ZimaOS, inside a temporary
   privileged container):

   ```sh
   deploy/native/bootstrap-debian.sh \
     --ssd-model "Lexar NS100" --ssd-serial "<ssd-serial>" \
     --hdd-model "<existing-hdd-model>" --hdd-serial "<hdd-serial>" \
     --ssh-keys-file /path/to/authorized_keys \
     --hostname paperclip-native
   ```

   This only ever sets UEFI `BootNext` (never `BootOrder`). ZimaOS stays the
   default boot target.

2. **Power-cycle the board once.** It boots Debian for this one boot only.
   If anything looks wrong, power-cycle again -- the board drops straight
   back into ZimaOS because `BootOrder` was never touched.

3. **On the booted Debian system**, install Paperclip at the live commit,
   restoring the data directory from the Phase 1 backup:

   ```sh
   deploy/native/install-paperclip.sh \
     --commit <the-exact-live-commit> \
     --data-src /path/to/restored/instances/default
   ```

4. **Fill in the real env files** the installer seeded as placeholders:
   `/srv/paperclip/env/paperclip.env`, `telegram.env`,
   `notes-vault-bridge.env`, and (if backups/vault-sync go to Drive)
   `rclone.env`. These are never committed and the installer never
   overwrites them once they exist.

5. **Install and start the systemd units:**

   ```sh
   sudo cp deploy/native/systemd/*.service deploy/native/systemd/*.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now paperclip.service paperclip-notes-vault-bridge.service
   sudo systemctl enable --now paperclip-backup.timer paperclip-watchdog.timer vault-drive-sync.timer
   ```

6. **Verify:** health check (`curl localhost:3100/api/health`), log in,
   a Telegram round-trip (trigger `systemctl start paperclip-watchdog.service`
   against a deliberately stopped `paperclip.service` and confirm the alert
   lands), one backup run (`sudo systemctl start paperclip-backup.service`),
   one vault sync.

7. **Only once 1-6 pass:** make Debian the default boot
   (`efibootmgr -o <debian-bootnum>`, confirming the number first with
   `efibootmgr`). Keep ZimaOS installed on the eMMC as a permanent rescue
   system (TOM-130 plan: this costs nothing to keep).

8. **Point the deploy key at `paperclip-deploy`** so Tom's approved-commit
   deploys land the same way they did on Docker:

   ```
   command="/srv/paperclip/current/deploy/native/paperclip-deploy" ssh-ed25519 AAAA... deploy-key
   ```

   Then `ssh host report`, `ssh host status`, and `ssh host deploy <commit>`
   all work as forced commands.

## Rollback

- **Before cutover (SSD only booted once, ZimaOS still default):** just
  power-cycle. `BootOrder` was never changed, so the board boots ZimaOS.
- **After `install-paperclip.sh` but before cutover:** same as above -- the
  Debian install is inert until it's made the default boot target in step 7.
- **A bad `paperclip-deploy deploy <commit>`:** automatic. It snapshots the
  DB before building, and on a failed post-deploy health check it switches
  `current` back to the previous release, restarts, and -- only if the
  migrations directory actually changed between the two commits -- restores
  the pre-deploy DB snapshot before restarting again. If the rolled-back
  service still fails its health check, the script exits non-zero and says
  manual intervention is needed; it does not loop.
- **After Debian is made the default boot (step 7):** `efibootmgr` back to
  the ZimaOS entry, reboot. The eMMC install is untouched throughout.

## Dry run everything

Every script accepts `--dry-run` and prints the exact commands it would run
without touching disks, services, env files, or git state:

```sh
deploy/native/bootstrap-debian.sh --ssd-model "Lexar NS100" --ssd-serial "" \
  --hdd-model "External" --hdd-serial "" --ssh-keys-file /path/to/keys --dry-run

deploy/native/install-paperclip.sh --commit <sha> --data-src /path/to/data --dry-run

deploy/native/paperclip-deploy deploy <sha> --dry-run
```

`bootstrap-debian.sh --dry-run` does not require real disks: disk/UUID
lookups are replaced with descriptive placeholders so the plan can be
reviewed on any machine, including one with no matching hardware at all.

## Checking this directory

```sh
# Lint every script (requires shellcheck on PATH)
shellcheck -x -P SCRIPTDIR deploy/native/*.sh deploy/native/lib/*.sh \
  deploy/native/scripts/*.sh deploy/native/paperclip-deploy

# Validate every systemd unit without needing real hardware or the
# paperclip user to exist on the checking machine
deploy/native/scripts/verify-systemd-units.sh
```
