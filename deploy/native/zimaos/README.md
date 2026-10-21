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
| `/usr/local/lib/paperclip/{scripts,lib}` (or `<root>/recovery` if that path isn't writable on this ZimaOS) | `paperclip-watchdog.sh`, `telegram-alert.sh`, `lib/common.sh`, (TOM-686) `paperclip-recover.sh`, `paperclip-oom-guard.sh`, and (TOM-690) `paperclip-net-heal.sh`, `paperclip-netwatch.sh`, `paperclip-quiet-restart.sh` | Outside the release tree -- a broken `current` symlink must not be able to break the alert/watchdog path that reports it |
| `/etc/systemd/system/paperclip-native-{recover,oom-guard}.service`, `paperclip-native.service.d/50-oom-guard.conf`, `paperclip-native-watchdog.service.d/50-recover.conf`, and (TOM-690) `paperclip-native-{net-heal,netwatch,quiet-restart}.{service,timer}` | The host safety net (TOM-686, TOM-690, see "Host safety net" below) | Installed and kept current by every `paperclip-update.sh` run; they name only the recovery path and `systemctl`, so they keep working after a rollback |
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

Since TOM-686 every run also:

- takes an exclusive `flock` on `<root>/logs/.paperclip-update.lock`
  (a second update is refused; the recovery unit stands back while it is
  held);
- arms an **exit trap** (EXIT, INT, TERM, HUP): after any failure, abort or
  signal, at any stage, it stops the build scope, points `current` back if
  the update had already switched it, probes `/api/health`, and restarts
  `paperclip-native.service` and waits for health **only if the server is
  down**. A healthy server is never restarted;
- installs the host safety net units, drop-ins and scripts (only the files
  that changed; `daemon-reload` only if a unit changed) before the build,
  and starts the OOM guard;
- runs the build pre-flight and the contained build described in "Build
  memory safety" below.

`--root` must be given on the live board (`/DATA/fastdrive/paperclip-native`);
the default above is the original install's path. `--mount-path` defaults
to the parent of `--root` and `--recovery-base` to
`/usr/local/lib/paperclip` if the watchdog script is installed there, else
`<root>/recovery`.

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

## Build memory safety

On 21 Oct a release build took the board down for over two hours (TOM-683,
diagnosis on TOM-685). Swap was already 5209MB of 5248MB used before the
build; `pnpm -r build` ran four packages at once with no limit; the host
live-locked about two minutes into the build, before the old 1200MB guard
fired; and the guard's `kill` reached only a bash subshell, so `tsc` kept
writing files for 41 more minutes. The pieces below, all in
`deploy/native/lib/common.sh`, close each of those gaps.

1. **Pre-flight** (`require_build_preflight`, `BUILD_EXIT=90`-class): the
   update refuses to start the build if swap use is above
   `--max-swap-used-pct`, or if `MemAvailable` is below
   `--host-memory-reserve-mb` + `--min-build-ceiling-mb`. Otherwise it
   clamps the build's ceiling to `MemAvailable - reserve`, so the build
   alone can never take the host below the reserve.
2. **Contained build** (`run_memory_guarded`): as root on systemd the build
   runs in its own transient scope, `paperclip-build-<sha12>.scope`
   (`systemd-run --scope` with `MemoryMax`, `MemorySwapMax`, `CPUWeight`,
   `IOWeight`, `--nice`), and in its own process group (`setsid`). If the
   build outgrows `MemoryMax`, the kernel OOM-kills a process **inside the
   scope**; the build fails and the rest of the host is not touched. Every
   build process also gets `oom_score_adj` 1000, so if the kernel ever has
   to kill something host-wide, the build goes first. **No ceiling, no
   build:** if `systemd-run` cannot create such a scope (checked with a
   throwaway probe scope first), the update refuses to build. The
   process-group-only mode (`BUILD_SCOPE_MODE=setsid`) exists for offline
   tests and is refused unless `BUILD_ALLOW_SETSID_FOR_TESTS=1`, which
   nothing in production sets. `systemd-run` gets `--expand-environment=no`,
   so `${...}` in the build's arguments is never rewritten.
3. **Mid-build guard** (`BUILD_EXIT=91`-class): `MemAvailable` is polled
   every `--build-memory-poll-seconds`; below `--min-build-memory-mb`
   (something else on the host is growing) the guard stops the build:
   SIGTERM to the whole scope and process group, SIGKILL after 10 seconds,
   then it **confirms the cgroup and the process group are empty** before
   it reports the abort. The scope is found by asking systemd for the
   scope's own `ControlGroup` (not by following the `systemd-run` client's
   PID), and the check fails closed: a scope that cannot be queried, whose
   `cgroup.procs` cannot be read, or that still holds a process or is still
   active after SIGKILL and `systemctl stop`, is a failure -- also when the
   build itself exited 0. The same stop runs from the update's exit trap.
   If the updater is killed with SIGKILL no trap runs and the scope keeps
   going; the next `paperclip-update.sh` (under the update lock) and
   `paperclip-recover.sh` (under the same lock) stop any leftover
   `paperclip-build-*.scope` before they build or restart.
4. **Capped parallelism**: `pnpm -r --workspace-concurrency=<n>`
   (`build-release.sh --workspace-concurrency`), and per-process caps:
   `NODE_OPTIONS=--max-old-space-size` for Node (pnpm, vite) and
   `GOMEMLIMIT` for TypeScript 7's `tsc`, which is a Go binary and ignores
   `NODE_OPTIONS`.
5. **Peak report**: at the end of the build the scope prints its exact
   `memory.peak` (`[build-scope] ... memory.peak=<n>MB`), and the update
   logs the sampled peak against the ceiling. Use it to tune the flags.

| Flag (`paperclip-update.sh`) | Default | Why this value |
|---|---|---|
| `--build-memory-max <size>` | `8G` | Measured on this board (21 Oct, TypeScript 7.0.2): the server `tsc` alone peaks at ~6.6GB RSS, ~5.5GB with `GOMEMLIMIT`; the UI typecheck at ~2.8GB. With two packages at once, 8GB fits the server compile plus one smaller package. The pre-flight clamp lowers it on a busier host. |
| `--build-swap-max <size>` | `256M` | Small on purpose: the build must not fill swap that the live server needs. Swap time in a build is thrash time. |
| `--host-memory-reserve-mb <n>` | `4096` | What the host keeps for everything else: the live server (3.3-4GB after a restart, 10GB peak seen after 4 days), the Kasm browser (capped at 3GiB), Tailscale, Docker and the OS. Jarvis set ~4GB on TOM-685. |
| `--min-build-ceiling-mb <n>` | `6144` | Below this the server `tsc` (~5.5GB) cannot finish, so the build would only die of its own OOM; refusing up front is cheaper. Together with the reserve: the build starts only with >= 10240MB available. |
| `--max-swap-used-pct <n>` | `50` | A host already deep in swap thrashes instead of OOM-killing (21 Oct: 99%). |
| `--min-build-memory-mb <n>` | `2048` | Mid-build trip level (was 1200, which fired after the host had already stalled). |
| `--build-memory-poll-seconds <n>` | `10` | Unchanged. |
| `--build-concurrency <n>` | `2` | pnpm's default is 4; 2 bounds the peak to about two packages. |
| `--build-node-heap-mb <n>` | `3072` | Node heap cap for pnpm/vite processes; well above what the UI build needs. |
| `--build-go-memory-limit-mb <n>` | `4096` | `GOMEMLIMIT` for `tsc`: a soft cap that makes Go collect garbage harder near it. Measured on the server typecheck: no limit ~6.6GB peak RSS; 4GiB ~5.7GB; 2.5GiB ~5.5GB but about twice as slow. `--checkers 1` (~4.8GB) or `--singleThreaded` (~4.4GB) would cut more, but those are `tsc` flags in the packages' own build scripts, outside `deploy/native`. |

CPUWeight 20, IOWeight 20 and nice 10 are fixed (`BUILD_CPU_WEIGHT`,
`BUILD_IO_WEIGHT`, `BUILD_NICE` in `lib/common.sh`): the live server and
agent runs always win CPU and disk contention against a build.

**If the pre-flight refuses**, the message gives the numbers: what is
available, what is needed, how many MB to free, and the three largest memory
users right now. The usual fix is `sudo docker stop hermes-browser` for the
build (start it again afterwards). If the long-running server has grown or
filled swap instead: restart
`paperclip-native.service` in a quiet window (or stop the `hermes-browser`
container for the build), then run the update again. Lower
`--host-memory-reserve-mb` only with a reason. `install-native-zimaos.sh`
uses the same contained build with its own `--min-build-memory-mb`
(default 1200) and no clamp, because a first install runs on an idle board.

## Host safety net

Installed by `paperclip-update.sh` (and `install-native-zimaos.sh`), all in
`deploy/native/zimaos/systemd/` and `deploy/native/zimaos/scripts/`. No
`Before=`, no early-boot target, no CasaOS/ZimaOS dependency (the 5 Oct
rule; `check-no-early-boot-deps.sh` now rejects any `Before=` and checks
drop-ins too).

- **`paperclip-native-recover.service`** (root, oneshot), started by
  `paperclip-native-watchdog.service`'s `OnFailure=` (drop-in
  `50-recover.conf`; the existing Telegram alert still fires next to it).
  It does nothing while `paperclip-update.sh` holds its lock. Otherwise it
  probes `/api/health` again after 30 seconds -- two consecutive failed
  probes -- then takes the same lock and keeps it to the end of the run, so
  an update cannot start between its last health check and the restart. Under
  the lock it probes once more, stops any build scope an updater left
  behind, and only then restarts `paperclip-native.service` and waits for
  health. Its unit quotes the script path, because the install root may
  contain a space (`/DATA/.media/External SSD/...`). At most one restart per 15 minutes
  (`<root>/logs/.paperclip-recover.last-restart`); a rate-limited or failed
  recovery exits non-zero, so its own `OnFailure=` alert tells a person.
- **`paperclip-native-oom-guard.service`** (root), pulled in by
  `paperclip-native.service` (drop-in `50-oom-guard.conf`, `Wants=`) and
  stopped with it (`PartOf=`). Every 0.2 seconds it sets `oom_score_adj` to
  -500 on the server's main process and its embedded Postgres, and raises
  every other process in the unit that is below 0 back to 0.
- **No hardware watchdog** (`RuntimeWatchdogSec` stays off): Jarvis decided
  against it on TOM-685; the 21 Oct freeze was a memory livelock that the
  pre-flight and the ceiling now prevent.

### Network self-heal, network-path check and quiet-hours restart (TOM-690)

On 21 Oct, after the first restart, the wired port had a cable link but no
DHCP lease for 31 minutes. Paperclip was healthy on loopback, so the
watchdog stayed green. Swap was also 99% full that morning, after the server
had run for 4 days. Three more units cover this. `paperclip-update.sh`
installs them with the rest of the safety net and enables and starts each
timer the first time it installs it; a timer someone has disabled stays
disabled on later updates.

- **`paperclip-native-net-heal.timer` / `.service`** (root, every minute,
  `paperclip-net-heal.sh`). It does nothing while `eth0` has an IPv4
  address and a default route, and nothing while it has no cable link
  (carrier 0: the cable, switch or router is off). With a cable link and no
  address for 5 minutes it takes one step every 5 minutes: `nmcli device
  connect eth0`; a link bounce (`nmcli device disconnect`, `ip link set
  down`, `ip link set up`, `nmcli device connect`); `systemctl restart
  NetworkManager`; then round again. A clean `systemctl reboot` after 30
  minutes is available but off (`PAPERCLIP_NET_HEAL_REBOOT=1` in the env
  file turns it on): never during an update, at most once per 6 hours.
  Every step and the end of every outage go to
  `<root>/logs/network-heal.log`. A port that has an address is never
  touched, so a test never needs to drop the live network; the offline test
  uses stubs and the host test a throwaway dummy interface.
- **`paperclip-native-netwatch.timer` / `.service`** (paperclip user, every
  5 minutes, `paperclip-netwatch.sh`): `eth0` has an address and a default
  route, Paperclip answers `/api/health` on the LAN address (not only
  127.0.0.1), DNS resolves `api.anthropic.com`, and
  `https://api.anthropic.com/` gives any HTTP answer. A failed round is
  tried again after 20 seconds; two failures exit non-zero, so its
  `OnFailure=` Telegram alert fires (it will reach Telegram only once the
  internet path is back), and the failure goes to
  `<root>/logs/network-watch.log`. It never restarts anything: a network
  fault is not fixed by restarting Paperclip.
- **`paperclip-native-quiet-restart.timer` / `.service`** (root, daily at
  about 04:30 local, after the 03:17 backup, `paperclip-quiet-restart.sh`).
  It restarts `paperclip-native.service` only if its anonymous memory plus
  swap is at least 6144 MB, host swap is at least 50% used, or it has run
  for 3 days; most nights it does nothing. It first waits up to 90 minutes
  for every agent run in the unit to finish (any process other than the
  server and its embedded Postgres), skips the night if one is still
  running, and restarts under the update lock. Every decision goes to
  `<root>/logs/quiet-restart.log`.

Each threshold is an environment variable in the env file; see the header
of each script for the names and defaults.

### What agent runs inherit for the OOM score

Agent runs start inside `paperclip-native.service`: the server forks them,
and a child inherits its parent's `oom_score_adj` at fork. So:

| Process | `oom_score_adj` |
|---|---|
| Server main process, embedded Postgres | -500 (same as dockerd) |
| An agent run (or git, or any other child of the server) | -500 for at most about 0.2 seconds after it starts (one guard pass, before it can allocate anything), then 0 |
| Anything an agent run starts after that | 0 (inherited from the agent) |
| Release build (inside its scope) | 1000 |
| For comparison on this board (21 Oct): `sshd` -1000, `containerd` -999, `dockerd` -500, `systemd-journald` -250, `tailscaled` 0, `NetworkManager` 0 | |

Agent runs therefore end up exactly as protected as Tailscale and
networking (0), never more. This is why the protection is a loop and not
`OOMScoreAdjust=` (that applies to every process of the unit) or a one-off
`ExecStartPost=+` on the main PID (every later agent run would inherit
-500). If the guard is not running, nothing is protected and everything in
the unit stays at 0 -- the safe way to fail.

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
3. **Native builds have hit memory limits on this board before**, and on
   21 Oct one took the whole board down. See "Build memory safety" above --
   this is why the pre-flight, ceiling and guard exist, not an optional
   nicety.
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
bash deploy/native/zimaos/scripts/tests/test-memory-guard-kills-tree.sh
bash deploy/native/zimaos/scripts/tests/test-build-scope-fail-closed.sh
# Needs root and systemd (exit 77 = skipped otherwise); proves the real scope:
sudo bash deploy/native/zimaos/scripts/tests/test-build-scope-systemd.sh
bash deploy/native/zimaos/scripts/tests/test-build-preflight-swap.sh
bash deploy/native/zimaos/scripts/tests/test-update-exit-trap.sh
bash deploy/native/zimaos/scripts/tests/test-host-safety-net.sh
deploy/native/zimaos/install-native-zimaos.sh --commit <sha> --repo-src <path> --dry-run
deploy/native/zimaos/paperclip-update.sh --commit <sha> --repo-src <path> --dry-run
```
