// Builds the native paperclip-runnerd binary (`cargo build --release ...`
// then stage-runner-binary.mjs) for the plain `pnpm run build` path, unless
// no cargo/Rust toolchain is present on PATH -- in which case this logs a
// clear skip message and exits 0 instead of failing the whole package
// build (TOM-294).
//
// This only gates the plain `build` script's `build:binary` step. Every
// other script that needs the real binary (build:rust, test:rust,
// report:capability-live-evals, trace:live-runner, the smoke:capability:*
// scripts, ...) still calls cargo directly and still hard-fails with no
// toolchain -- those are dev/CI-only paths where cargo is a known
// requirement, not a host-install path that must tolerate its absence.
//
// Why this lives here rather than in deploy/native/ excluding
// @paperclipai/paperclip-runner via build-release.sh's --exclude-package
// (the mechanism TOM-283 added for @paperclipai/tailscale-https-broker):
// server/package.json's own `build` script calls
// `pnpm --filter @paperclipai/paperclip-runner build` directly
// (`prepare:runner-vendor`), not through the root `pnpm -r build` that
// --exclude-package's negative filter affects. Excluding this package from
// the recursive build would not stop that direct call, so server's build
// would still shell out to cargo and still fail. Skipping only the
// binary-compile step, inside this package's own build, is what actually
// lets server (and the native installer's unmodified `pnpm run build`)
// succeed on a host with no cargo.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function cargoAvailable() {
  const probe = spawnSync("cargo", ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

if (!cargoAvailable()) {
  console.log(
    "No cargo/Rust toolchain found on PATH; skipping the paperclip-runnerd native binary build (TOM-294). " +
      "@paperclipai/paperclip-runner will vendor without dist/bin/paperclip-runnerd on this host -- any " +
      "feature that spawns that binary directly (ACPX/live sessions, the durable control plane) will be " +
      "unavailable here until a toolchain or a prebuilt binary is staged. The rest of this package, and " +
      "anything that vendors it (e.g. server's build), still builds normally.",
  );
  process.exit(0);
}

console.log("cargo resolved on PATH; building the paperclip-runnerd binary.");

const build = spawnSync(
  "cargo",
  ["build", "--release", "--manifest-path", "runner/Cargo.toml", "--locked", "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd"],
  { cwd: packageRoot, stdio: "inherit" },
);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const stage = spawnSync(process.execPath, ["scripts/stage-runner-binary.mjs"], { cwd: packageRoot, stdio: "inherit" });
process.exit(stage.status ?? 0);
