# Native ZimaOS install (TOM-256)

Runs Paperclip as a systemd service with its entire tree on the external
drive. **ZimaOS stays. Docker stays installed but unused.** This replaces
the shelved Debian-on-SSD migration (`deploy/native/*.sh`,
`deploy/native/bootstrap-debian.sh`, `deploy/native/scripts/prestage-*`,
etc. -- kept as evidence, not deleted), which caused a 16.5-hour outage
because an OS nobody had watched boot never came up. This route never
reboots the board at all.

**Nothing in this directory has been run against real hardware yet.**
Every script has a `--dry-run` that prints its plan without touching
disks, services, env files, or systemd. See `scripts/run-gates.sh` for the
full set of offline checks this directory passes today.

## What runs where

| Location | What | Why |
|---|---|---|
| `<root>` (default `/DATA/.media/External SSD/paperclip-native`) | Node toolchain, every release, instance data (incl. embedded Postgres), env files, the `paperclip` user's home, logs | Must survive a reboot; `/var`, `/tmp`, `/run` are tmpfs on ZimaOS and are wiped every boot |
| `/etc/systemd/system/paperclip-native*` | The unit files themselves | `/etc` is `overlayfs rw` (`upperdir=/mnt/overlay/upper_etc` on `/dev/mmcblk0p7`), confirmed persistent across the 14 Sep RAUC 1.7.1 update and every reboot since |
| `/usr/local/lib/paperclip/{scripts,lib}` (or `<root>/recovery` if that path isn't writable on this ZimaOS) | `paperclip-watchdog.sh`, `telegram-alert.sh`, `lib/common.sh` | Outside the release tree -- a broken `current` symlink must not be able to break the alert/watchdog path that reports it |
| ZimaOS / CasaOS / Docker | Untouched | Docker keeps running the existing container on port 3100 throughout the parallel-run proof |

The service listens on the `PORT` set in `<root>/env/paperclip-native.env`
(default **3101**, not 3100), specifically so it can run side by side with
the Docker container while it is being proved out. Cutting over to 3100 is
a one-line env change plus a restart -- never an edit to the unit file.

## Order of operations

### 1. Parallel-run proof

```sh
deploy/native/zimaos/install-native-zimaos.sh \
  --commit <the-exact-live-commit> \
  --repo-src /path/to/a/local/toms-lab/checkout \
  --data-src /path/to/a/restored/instances/default \
  --paperclip-env-file /path/to/filled/paperclip-native.env \
  [--telegram-env-file ...] [--rclone-env-file ...] \
  [--expected-root-uuid <uuid>]
```

`--repo-src` is a **local checkout path**, never a URL -- the board holds
no GitHub credential and the repository is private, so there is no
git-clone-from-remote anywhere in this script. `--data-src` is optional;
omit it for a brand-new instance with no prior data.

This creates the `<root>` layout, the `paperclip` system user (home
`<root>/home`, never `/home`), downloads and SHA-256-verifies the Node 24
tarball, builds the release (memory-guarded -- see below), restores data if
given, writes env files, installs `paperclip-watchdog.sh`/
`telegram-alert.sh` to their fixed recovery location, installs and enables
the systemd units, and asserts every unit's `ExecStart` binary actually
exists and is executable (`check-execstart-targets.sh --root /`, since
ZimaOS is not chrooted the way the Debian route is -- `/` here already is
the live filesystem). It does **not** start `paperclip-native.service`.

Then, manually:

```sh
# Fill in BETTER_AUTH_SECRET (and anything else left blank) in
# <root>/env/paperclip-native.env first.
sudo systemctl start paperclip-native.service
curl -fsS http://127.0.0.1:3101/api/health

# Prove the alert path:
sudo systemctl stop paperclip-native.service
sudo systemctl start paperclip-native-watchdog.service   # should fail and alert via Telegram
sudo systemctl start paperclip-native.service

# Prove backup + vault sync once each:
sudo systemctl start paperclip-native-backup.service
sudo systemctl start paperclip-native-vault-sync.service
```

Run this side by side with the existing Docker container for as long as
you want before trusting it.

### 2. Cutover

One env change plus a restart -- no unit edit, no reboot:

```sh
sudo sed -i 's/^PORT=.*/PORT=3100/' "<root>/env/paperclip-native.env"
sudo systemctl stop <the-docker-container>   # frees port 3100
sudo systemctl restart paperclip-native.service
curl -fsS http://127.0.0.1:3100/api/health
```

Keep the Docker container installed (just stopped) as the rollback path.

### 3. Rollback

```sh
sudo systemctl stop paperclip-native.service
sudo systemctl start <the-docker-container>   # back on 3100 immediately
# optionally:
sudo sed -i 's/^PORT=.*/PORT=3101/' "<root>/env/paperclip-native.env"
```

Nothing about ZimaOS, Docker, or any other unit was ever changed, so there
is no boot-order or ESP state to undo -- unlike the Debian route, this
never reboots the board.

### Later deploys

```sh
deploy/native/zimaos/paperclip-update.sh --commit <sha> --repo-src /path/to/local/checkout
```

Same contract as `deploy/native/paperclip-deploy deploy <commit>`: DB dump
first, build, switch `current`, restart, health-check, and on failure
switch `current` back (restoring the DB dump too, if a migration ran) and
restart again.

**Build time:** not yet measured on the real board -- this task is
repository-only and never touched the board (see the top of this file).
The existing Docker route's image build has taken roughly an hour on this
host under memory pressure (see `lab-build-failure-signatures` lessons);
the native build skips the Docker image-layer rebuild and network-fetch-
per-layer entirely (`pnpm install --frozen-lockfile` + `pnpm run build`
directly against a warm pnpm store under `<root>/home`), so it should be
substantially faster, but state a real number here once it has actually
been timed on ZimaOS.

## Migrating an existing instance

`env/paperclip-native.env.example` groups its variables into *required for
a 1:1 migration of an existing instance* and *optional*. A migration (as
opposed to a brand-new install with no `--data-src`) must carry every
variable in the required group across from the live instance's actual
process environment -- not regenerate it, and not rely on the template's
defaults:

- **Never regenerate `BETTER_AUTH_SECRET`, `PAPERCLIP_AGENT_JWT_SECRET`,
  `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`, or
  `PAPERCLIP_NOTES_VAULT_BRIDGE_TOKEN`.** Read them out of the running
  instance's own process environment (e.g. `tr '\0' '\n' <
  /proc/<server-pid>/environ`) and copy them verbatim. Regenerating
  `BETTER_AUTH_SECRET` or `PAPERCLIP_AGENT_JWT_SECRET` invalidates every
  existing session and every existing agent API key -- there is no
  graceful transition, every credential issued under the old value simply
  stops validating.
- **`PAPERCLIP_SECRETS_MASTER_KEY_FILE` must point at the carried-over
  key file, not a freshly generated one.** Without the correct key, every
  stored credential in the database is undecryptable.
- **`PAPERCLIP_NOTES_VAULT_BRIDGE_URL` needs rewriting, not copying.**
  Its default value in the live Docker stack is the Docker-network DNS
  name `http://notes-vault-bridge:8787`. A native systemd service is not
  on that Docker network and cannot resolve that hostname, so this value
  must be rewritten to a host-reachable address (loopback, LAN, or
  Tailscale) before the native service will be able to reach the bridge.
  Host reconnaissance confirmed the bridge container publishes no ports
  (`docker port` is empty) but does answer on its Docker-network IP from
  the host (`HTTP 401` -- reachable, just unauthenticated at that probe).
  The durable fix is to **publish the bridge's port on loopback** in the
  Docker stack (e.g. `127.0.0.1:8787:8787`), so a native service can reach
  it at `http://127.0.0.1:8787` without depending on the container's
  internal network IP, which is not guaranteed stable across container
  recreation. This is a recommendation only -- no compose file is changed
  by this task.
- Everything else in the "required for a 1:1 migration" group
  (`PAPERCLIP_STORAGE_PROVIDER`/`PAPERCLIP_STORAGE_LOCAL_DIR`,
  `PAPERCLIP_SECRETS_STRICT_MODE`, the notes-vault company/writer-agent
  settings, `PAPERCLIP_INSTANCE_ID`) must match the live instance's values
  too, or the migrated instance will start with the wrong attachments
  path, the wrong decrypt-strictness, or the wrong data directory.

## Memory-guarded build

Both `install-native-zimaos.sh` and `paperclip-update.sh` call
`require_memory_available_mb` (pre-flight: refuses to start the build if
`MemAvailable` is already too low -- a `BUILD_EXIT=90`-class failure,
caught before any work starts) and `run_memory_guarded` (polls
`MemAvailable` while the build runs and cancels it if memory drops too low
mid-build -- a `BUILD_EXIT=91`-class failure), both in
`deploy/native/lib/common.sh`. Tune with `--min-build-memory-mb` and
`--build-memory-poll-seconds`. Native Node/pnpm builds have aborted on
this board for memory before; this is the same class of guard, reasoned
from that history, not a port of an existing script (no prior
memory-guarded build script exists elsewhere in this repository to
retarget).

## Mount safety

The installer never assumes a `/dev/sdX` name. It confirms the external
drive is mounted at `--mount-path` (default `/DATA/.media/External SSD`)
and, if `--expected-root-uuid` is given, that the filesystem backing that
mount matches that UUID exactly (`require_mount_uuid` in
`lib/common.sh`, via `findmnt` + `blkid`). Device enumeration has already
shifted once on this board when a second drive was fitted; pin the UUID
once you know it.

## Recovery-path scripts

`paperclip-watchdog.sh` and `telegram-alert.sh` (reused unmodified from
`deploy/native/scripts/` -- both already take their paths from the
environment, so neither needed retargeting) are installed to
`/usr/local/lib/paperclip/{scripts,lib}` if that is writable on this
ZimaOS, or to `<root>/recovery` otherwise. The installer detects this at
install time with a real write test (`resolve_recovery_base` in
`lib/common.sh`) and renders the unit files' `ExecStart=` to match --
**never under `current/`**, so a broken release cannot break the thing
that reports it. Host reconnaissance confirmed `/usr/local/lib` does not
exist and cannot be created on the real board, so `<root>/recovery` is
the branch that actually runs there, not a contingency that only exists
in the code -- `scripts/tests/test-recovery-base-fallback.sh` (wired into
`run-gates.sh`) exercises it directly by giving `resolve_recovery_base` a
genuinely unwritable preferred path.

## Host tooling: nothing assumed beyond what the installer brings

Host reconnaissance (TOM-264) found the real board's root `PATH`
(`/usr/bin:/usr/sbin`) has no system `node`, `pnpm`, `corepack`, `make`,
`cc`, `gcc`, or `openssl` -- ZimaOS is a Buildroot appliance with no
package manager, so these are never assumed to exist on the host:

- **`node`, `pnpm`, `corepack`** ship inside the Node tarball
  `install-native-zimaos.sh` itself downloads and SHA-256-verifies into
  `<root>/toolchain/node`. Nothing under `deploy/native/zimaos/` lists
  any of the three in a hard `require_cmd` check; every invocation uses
  the toolchain's own `bin/` (by absolute path, or via `PATH` pinned to
  it in `BUILD_ENV`) instead.
- **`runuser` is absent on the real board.** `drop_priv_run` in
  `lib/common.sh` resolves the best available way to run a command as
  the unprivileged `paperclip` user once per script run, trying
  `runuser`, then `setpriv`, then `su`, and fails with a clear message
  naming all three only if none exists.
  `setpriv` is additionally **flag-probed, not just existence-checked**:
  the board's `setpriv` is a cut-down build that is on `PATH` but rejects
  util-linux's `--reuid`, which is how the first real install died
  (`setpriv: unrecognized option '--reuid'`, three seconds in, before any
  write). The probe runs the exact flag set the `setpriv` branch passes,
  against the caller's own uid/gid, using only bash builtins; only an
  option-parsing refusal demotes the helper, so a permission error on an
  unprivileged probe does not.
  `scripts/tests/test-drop-priv-helper-fallback.sh` proves the fallback
  order by masking each helper out of `PATH` in turn, proves the probe's
  three outcomes with stubbed `setpriv` variants, and
  `scripts/tests/test-drop-priv-run-quoting.sh` proves the `su` branch --
  the only one that has to round-trip argv through a single `-c` string --
  preserves every argument unchanged. That second test is not academic:
  the mount path is `/DATA/.media/External SSD`, so every `BUILD_ENV`
  entry handed to `drop_priv_run` contains a space.
- `python3` is present and is used wherever a script needs something
  `openssl` would otherwise have done.

## Four caveats

1. **`/etc/systemd/system` may not survive every future ZimaOS update.**
   The 14 Sep RAUC 1.7.1 update preserved it, but that is not a guarantee
   for every future update. Re-run `install-native-zimaos.sh` after any
   ZimaOS/RAUC update and confirm `systemctl status paperclip-native.service`
   still resolves -- it is idempotent and safe to re-run.
2. **No Docker sandbox.** Unlike the container route, a fault in an agent
   running under this native service can reach every mounted drive, not
   just a container's bind mounts. Tom has accepted this explicitly as
   part of this design (TOM-256).
3. **Native builds have hit memory limits on this board before.** See
   "Memory-guarded build" above -- this is why that guard exists, not an
   optional nicety.
4. **PostgreSQL refuses to run as root.** The embedded Postgres under
   `<root>/data` requires the dedicated `paperclip` system user -- this is
   why `install-native-zimaos.sh` creates it rather than running everything
   as root, even though the installer itself must run as root to create
   that user and install the units.

## Checking this directory

```sh
# Everything in one place (shellcheck, shebang check, systemd-analyze
# verify, the two new boot/state gates, the shared check-execstart-targets
# offline test, and both --dry-run runs):
deploy/native/zimaos/scripts/run-gates.sh

# Individually:
shellcheck -x -P SCRIPTDIR deploy/native/zimaos/*.sh deploy/native/zimaos/scripts/*.sh
deploy/native/scripts/verify-systemd-units.sh --units-dir deploy/native/zimaos/systemd
deploy/native/scripts/check-no-early-boot-deps.sh --units-dir deploy/native/zimaos/systemd
deploy/native/scripts/check-no-state-outside-run-root.sh deploy/native/zimaos
bash deploy/native/scripts/tests/test-check-execstart-targets.sh
bash deploy/native/zimaos/scripts/tests/test-copy-tree-rsync-fallback.sh
bash deploy/native/zimaos/scripts/tests/test-port-no-ambient-override.sh
bash deploy/native/zimaos/scripts/tests/test-drop-priv-helper-fallback.sh
bash deploy/native/zimaos/scripts/tests/test-recovery-base-fallback.sh
deploy/native/zimaos/install-native-zimaos.sh --commit <sha> --repo-src <path> --dry-run
deploy/native/zimaos/paperclip-update.sh --commit <sha> --repo-src <path> --dry-run
```
