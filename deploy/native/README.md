# Native Debian deploy (TOM-130 / TOM-133 / TOM-202) -- SHELVED

Repeatable scripts that replace ZimaOS + Docker + Hermes with a minimal
Debian 13 (trixie) running Paperclip directly, on the new Lexar NS100 SSD.
ZimaOS stays untouched on the eMMC as the way back. See the TOM-130 `plan`
and `hermes-inventory` issue documents for the full migration plan; this
file covers only the mechanics of the scripts in this directory.

**This migration is shelved** (16.5-hour outage, 10 Oct 2026: an OS nobody
had watched boot never came up). The scripts below stay as evidence --
they are not deleted or rewritten. The live replacement design is
`zimaos/`: ZimaOS stays, Docker stays installed but unused, and Paperclip
runs as a native systemd service on the external drive, with no reboot
and no dual-boot cutover involved. See `zimaos/README.md`. Several
scripts here are shared between both routes (`lib/common.sh`,
`scripts/build-release.sh`, `scripts/check-execstart-targets.sh`,
`scripts/verify-systemd-units.sh` -- the latter now takes `--units-dir` so
it checks either unit set), so a fix made for one benefits both.

**Nothing in this directory has been run against real hardware yet.** Every
script has a `--dry-run` that prints its plan without touching disks,
services, or data.

The moment the board boots Debian, the Paperclip container, Hermes and the
`lab-claude-remote` session all stay behind on ZimaOS -- there is no agent
left on the box, and Tom does not type commands. So everything that
install, data restore, env files and systemd units need happens **before**
the first reboot, from the ZimaOS side (`prestage-paperclip.sh`). The board
then boots into a system that serves Paperclip on its own, and
`paperclip-firstboot.service` decides -- unattended -- whether that worked.

## What's here

| Path | Purpose |
|---|---|
| `bootstrap-debian.sh` | Partitions the SSD, debootstraps trixie, writes fstab by UUID, installs GRUB + base packages + the Tailscale/Cloudflare apt repos, sets a one-time UEFI `BootNext`. Run from ZimaOS inside a temporary privileged container. |
| `scripts/prestage-paperclip.sh` | Runs on the ZimaOS side, against the SSD `bootstrap-debian.sh` just built. Creates the `paperclip` user, builds the release in a chroot, restores the data directory, writes the real env files, carries over the Tailscale/Cloudflare identities, and enables every systemd unit -- all before the first reboot. **The migration-day route.** |
| `install-paperclip.sh` | The same install, run manually on an already-booted Debian system instead. Kept for later manual recovery (e.g. reinstalling after the box is already live); not the migration-day path, because nothing can run it unattended on a freshly-booted box with no agent on it. |
| `paperclip-deploy` | Native `report` / `status` / `deploy <commit>` commands, usable as an SSH forced command, for ordinary deploys once the box is live. Deploy = DB snapshot, build, switch `current`, restart, health check, automatic rollback. |
| `systemd/` | Unit files: `paperclip.service`, `paperclip-notes-vault-bridge.service`, backup/watchdog/vault-sync timers + services, `paperclip-firstboot.service` (polls health after the very first boot and reboots back to ZimaOS on failure), and the `paperclip-alert@.service` Telegram template every timer's `OnFailure=` points at. |
| `scripts/` | Helpers invoked by the units above: `paperclip-backup.sh` and `vault-drive-sync.sh` (ordinary ops, still run from inside the release tree); `paperclip-watchdog.sh`, `telegram-alert.sh` and `paperclip-firstboot.sh` (recovery-path scripts -- installed to the fixed, outside-the-release-tree location `/usr/local/lib/paperclip/scripts/` by `prestage-paperclip.sh`, see "Recovery-path scripts" below); the shared release builder (`build-release.sh`); `prestage-paperclip.sh`; `check-execstart-targets.sh` (asserts every unit's `ExecStart` binary actually exists and is executable in a target root); and a repeatable `systemd-analyze verify` check (`verify-systemd-units.sh`). |
| `scripts/tests/` | Offline tests: `test-check-execstart-targets.sh` and `test-paperclip-firstboot.sh` (stubs curl/systemctl/journalctl as bash functions -- no real network, systemd, or reboot). |
| `env/*.env.example` | Templates for the env files under `/srv/paperclip/env/`. Copy, fill in, never commit the real files. |
| `lib/common.sh` | Shared logging/dry-run/retry helpers sourced by every script. |

### Recovery-path scripts live outside the release tree

`paperclip-firstboot.sh`, `paperclip-watchdog.sh` and `telegram-alert.sh` (and
the `lib/common.sh` they source) are installed by `prestage-paperclip.sh` to
`/usr/local/lib/paperclip/{scripts,lib}/` in the target root, and every unit
that runs them points `ExecStart=` there -- never at
`/srv/paperclip/current/...`. The release symlink can be broken or
half-built; these scripts are the thing that detects and recovers from
exactly that, so they cannot depend on it. `paperclip-backup.sh` and
`vault-drive-sync.sh` stay inside the release tree on purpose -- they are
ordinary scheduled maintenance, not part of the rollback path, and their own
failure (via the now-fixed-location `telegram-alert.sh`) is still reported
correctly either way.

`prestage-paperclip.sh` also runs `check-execstart-targets.sh` against the
mounted target root after installing and enabling every unit, and fails
loudly if any unit's `ExecStart` binary is missing or not executable there
(resolving symlinks, so a broken `current` pointer is still caught).
`verify-systemd-units.sh`'s fakeroot cannot catch this class of bug -- it
stubs a file at every *known* script path before calling `systemd-analyze
verify`, so it will always find something there even if the real pre-stage
forgot to put the file at that path. That is exactly how the firstboot
script went missing from a staged release undetected (TOM-205/TOM-224);
`check-execstart-targets.sh` checks the real, already-staged target instead.

## Before migration day

1. Fit the Lexar NS100 SSD (do not remove the eMMC or the existing HDD).
2. Confirm the SSD's model/serial with `lsblk -o NAME,MODEL,SERIAL,SIZE` from
   ZimaOS -- `bootstrap-debian.sh` and `prestage-paperclip.sh` both identify
   disks by model/serial, never by `sdX` name.
3. Prepare an `authorized_keys`-format file with the SSH keys that should
   have access to the new system. No keys are copied from ZimaOS.
4. Take the Phase 1 backups from the TOM-130 plan (DB dump, data directory,
   vault, Hermes configs) and confirm the restore drill passed.
5. Have ready, as **file paths** (never typed in as values):
   - a filled-in copy of `env/paperclip.env.example` (and, if you want
     alerting/backups/vault-sync working from the first boot, filled copies
     of `telegram.env.example`, `notes-vault-bridge.env.example`,
     `rclone.env.example` too),
   - the Tailscale node state file and the Cloudflare tunnel credentials
     directory from the live ZimaOS host -- TOM-203 reports their exact
     paths. Carrying these over keeps the board's Tailscale IP and Cloudflare
     tunnel identity unchanged; skipping them means re-authenticating both
     after first boot.
6. Confirm this host already holds a full git checkout of `toms-lab` at the
   commit you're deploying -- that checkout's path is what you pass to
   `--repo-src` below. The repository is private and the new box has no
   GitHub credential yet, so this local-path route is what avoids needing
   one on migration day.
7. Dry-run every script once and read the output (see "Dry run everything"
   below).

## Migration day, in order

Run `bootstrap-debian.sh` and `prestage-paperclip.sh` for real only once the
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
   default boot target. It leaves the SSD unmounted when it finishes.

2. **Pre-stage the whole install onto the SSD**, still from ZimaOS, before
   any reboot:

   ```sh
   deploy/native/scripts/prestage-paperclip.sh \
     --ssd-model "Lexar NS100" --ssd-serial "<ssd-serial>" \
     --commit <the-exact-live-commit> \
     --repo-src /path/to/the/zimaos/toms-lab/checkout \
     --data-src /path/to/restored/instances/default \
     --paperclip-env-file /path/to/filled/paperclip.env \
     --telegram-env-file /path/to/filled/telegram.env \
     --notes-vault-bridge-env-file /path/to/filled/notes-vault-bridge.env \
     --tailscale-state-file /path/to/zimaos/tailscaled.state \
     --cloudflared-dir /path/to/zimaos/cloudflared
   ```

   This mounts the SSD it just built, creates the `paperclip` user, builds
   the release in a chroot (so native modules match the target's glibc/Node
   ABI), restores the data directory, writes the real env files, carries
   over the Tailscale/Cloudflare identities, installs every systemd unit
   and enables them (`systemctl --root=`, no boot required), then unmounts.
   After this the SSD is a complete, self-starting Paperclip install.

3. **Power-cycle the board once.** It boots Debian for this one boot only.
   `paperclip-firstboot.service` polls `/api/health` for up to four minutes
   (`DEADLINE_SECONDS` in `paperclip-firstboot.sh` -- a reasoned default,
   not a hardware measurement; re-check it against the real first-boot
   timing and adjust if needed, keeping the unit's `TimeoutStartSec`
   comfortably above it):

   - **Success:** it records that to `/boot/efi/paperclip-firstboot-status.txt`
     and disables itself. The board is now running Paperclip, unattended.
   - **Failure, including Paperclip never starting at all** (crash loop,
     dependency failure, mount failure): it records that (with a
     `paperclip.service` state and journal tail) to the same file and
     reboots. The unit does not `Requires=paperclip.service` -- only
     `After=`, as a soft ordering hint -- specifically so a `paperclip.service`
     that never reaches "active" at all still cannot stop this gate from
     firing and rebooting. Because `bootstrap-debian.sh` only ever sets
     `BootNext` (never `BootOrder`), that reboot lands straight back in
     ZimaOS -- no human needed.

   Either way, that status file is on the FAT32 ESP, so it is readable from
   ZimaOS afterwards without booting Debian again:
   `mount <esp-partition> /mnt && cat /mnt/paperclip-firstboot-status.txt`.

4. **On a failed first boot:** read the status file, fix the problem (it is
   almost certainly something `prestage-paperclip.sh` staged incorrectly --
   re-run it; it is safe to re-run), and power-cycle again.

5. **On a successful first boot, verify:** log in, a Telegram round-trip
   (`sudo systemctl start paperclip-watchdog.service` against a deliberately
   stopped `paperclip.service` and confirm the alert lands), one backup run
   (`sudo systemctl start paperclip-backup.service`), one vault sync.

6. **Only once verification passes:** make Debian the default boot
   (`efibootmgr -o <debian-bootnum>`, confirming the number first with
   `efibootmgr`). Keep ZimaOS installed on the eMMC as a permanent rescue
   system (TOM-130 plan: this costs nothing to keep).

7. **Point the deploy key at `paperclip-deploy`** so Tom's approved-commit
   deploys land the same way they did on Docker:

   ```
   command="/srv/paperclip/current/deploy/native/paperclip-deploy" ssh-ed25519 AAAA... deploy-key
   ```

   Then `ssh host report`, `ssh host status`, and `ssh host deploy <commit>`
   all work as forced commands. (`paperclip-deploy` builds from
   `--repo-url`, so the box needs its own GitHub credential by this point --
   a deploy key on the box itself, separate from the migration-day
   `--repo-src` route above.)

## Rollback

- **Before cutover (SSD only booted once, ZimaOS still default):** just
  power-cycle. `BootOrder` was never changed, so the board boots ZimaOS.
- **After `prestage-paperclip.sh` but before cutover:** same as above -- the
  Debian install is inert until it's made the default boot target in step 6.
- **A failed first boot:** automatic -- `paperclip-firstboot.service`
  reboots back to ZimaOS on its own (see step 3 above).
- **A bad `paperclip-deploy deploy <commit>`:** automatic. It snapshots the
  DB before building, and on a failed post-deploy health check it switches
  `current` back to the previous release, restarts, and -- only if the
  migrations directory actually changed between the two commits -- restores
  the pre-deploy DB snapshot before restarting again. If the rolled-back
  service still fails its health check, the script exits non-zero and says
  manual intervention is needed; it does not loop.
- **After Debian is made the default boot (step 6):** `efibootmgr` back to
  the ZimaOS entry, reboot. The eMMC install is untouched throughout.

## Dry run everything

Every script accepts `--dry-run` and prints the exact commands it would run
without touching disks, services, env files, or git state:

```sh
deploy/native/bootstrap-debian.sh --ssd-model "Lexar NS100" --ssd-serial "" \
  --hdd-model "External" --hdd-serial "" --ssh-keys-file /path/to/keys --dry-run

deploy/native/scripts/prestage-paperclip.sh --ssd-model "Lexar NS100" --ssd-serial "" \
  --commit <sha> --repo-src /path/to/checkout --data-src /path/to/data \
  --paperclip-env-file /path/to/paperclip.env --dry-run

deploy/native/install-paperclip.sh --commit <sha> --data-src /path/to/data \
  --repo-src /path/to/checkout --dry-run

deploy/native/paperclip-deploy deploy <sha> --dry-run
```

`bootstrap-debian.sh` and `prestage-paperclip.sh --dry-run` do not require
real disks: disk/UUID lookups are replaced with descriptive placeholders so
the plan can be reviewed on any machine, including one with no matching
hardware at all.

`deploy/native/scripts/paperclip-firstboot.sh --dry-run` prints its plan
(health URL, poll budget, where the status file lands) without polling,
writing the status file, disabling the unit, or rebooting. The real unit
never passes `--dry-run` -- it exists only so the plan can be reviewed
without a real first boot.

## Checking this directory

```sh
# Lint every script (requires shellcheck on PATH)
shellcheck -x -P SCRIPTDIR deploy/native/*.sh deploy/native/lib/*.sh \
  deploy/native/scripts/*.sh deploy/native/scripts/tests/*.sh \
  deploy/native/paperclip-deploy

# Validate every systemd unit without needing real hardware or the
# paperclip user to exist on the checking machine. Cannot catch a missing
# ExecStart target -- see check-execstart-targets.sh for that.
deploy/native/scripts/verify-systemd-units.sh

# Assert every unit's ExecStart binary exists and is executable in a given
# target root (used by prestage-paperclip.sh against the real mounted SSD;
# point --root at any directory tree to check it standalone).
deploy/native/scripts/check-execstart-targets.sh --root /path/to/mounted/target

# Offline tests -- no real hardware, network, systemd, or reboot
bash deploy/native/scripts/tests/test-check-execstart-targets.sh
bash deploy/native/scripts/tests/test-paperclip-firstboot.sh
```
