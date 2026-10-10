#!/usr/bin/env bash
# Offline test for TOM-283: build-release.sh's --exclude-package option and
# install-native-zimaos.sh's C-compiler probe that decides when to pass it.
#
# The real board's native build died the first time it reached the real
# build step: @paperclipai/tailscale-https-broker's build script shells out
# to `cc` to compile a Node add-on, and the board has no C compiler. That
# package is a host-only daemon the native install does not run (no systemd
# unit for it under deploy/native/zimaos/systemd/), so the fix is to leave
# it out of the build on a host that cannot build it, not to install a
# compiler.
#
# Covers:
#   (a) build-release.sh with no --exclude-package: --dry-run output is
#       unchanged from before this option existed (plain `pnpm run build`).
#   (b) build-release.sh with --exclude-package: actually runs
#       `pnpm run preflight:workspace-links` then the filtered
#       `pnpm -r --filter '!<pkg>' build`, against a real two-package pnpm
#       workspace fixture built with the exact pnpm version
#       (corepack-pinned 9.15.4) this script activates -- proving the
#       negative-filter syntax actually excludes a package on that pinned
#       version, rather than assuming it from pnpm's docs. Excluded
#       package's build script must not run; the other package's must.
#   (c) install-native-zimaos.sh's C-compiler probe: resolves and logs a
#       compiler when one is on PATH (or $CC), and logs+excludes the broker
#       package when none is -- exercised end-to-end via --dry-run (no root
#       needed), which also proves the decision is visible in --dry-run
#       output per the task's requirement.
#   (d) paperclip-update.sh's use of the same shared resolve_c_compiler()
#       probe (TOM-286): same two directions as (c) -- compiler present ->
#       resolved, logged, no exclusion; no compiler -> excluded, logged,
#       visible in --dry-run's build-release.sh invocation -- proving the
#       update path does not regress to the pre-TOM-286 `spawnSync cc
#       ENOENT` failure on a host with no compiler.
#
# Usage: test-exclude-broker-no-compiler.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIMAOS_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
NATIVE_DIR="$(cd "$ZIMAOS_DIR/.." && pwd)"
BUILD_RELEASE_SH="$NATIVE_DIR/scripts/build-release.sh"
INSTALL_SH="$ZIMAOS_DIR/install-native-zimaos.sh"
UPDATE_SH="$ZIMAOS_DIR/paperclip-update.sh"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(make_exec_capable_tempdir paperclip-exclude-broker-test "$NATIVE_DIR")"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# git commands below must not inherit this sandbox's empty
# GIT_AUTHOR_NAME/EMAIL (set to "" in the environment, which overrides any
# user.name/user.email config and makes `git commit` fail with "empty
# ident name"). Unset them for every git invocation in this test.
git_clean_env() {
  env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL git "$@"
}

# ---------------------------------------------------------------------------
# Fixture: a tiny real pnpm workspace with two packages, mirroring the root
# repo's own build scripts (`preflight:workspace-links` then `pnpm -r
# build`) closely enough to exercise the same pnpm filter mechanism.
# ---------------------------------------------------------------------------
FIXTURE="$WORKDIR/fixture-repo"
mkdir -p "$FIXTURE/packages/pkg-a" "$FIXTURE/packages/pkg-b"

cat > "$FIXTURE/package.json" <<'EOF'
{
  "name": "fixture-root",
  "private": true,
  "packageManager": "pnpm@9.15.4",
  "scripts": {
    "preflight:workspace-links": "node -e \"require('fs').writeFileSync('preflight.marker','1')\"",
    "build": "pnpm run preflight:workspace-links && pnpm -r build"
  }
}
EOF

cat > "$FIXTURE/pnpm-workspace.yaml" <<'EOF'
packages:
  - packages/*
EOF

cat > "$FIXTURE/packages/pkg-a/package.json" <<'EOF'
{
  "name": "@fixture/pkg-a",
  "private": true,
  "scripts": { "build": "node -e \"require('fs').writeFileSync('built.marker','1')\"" }
}
EOF

cat > "$FIXTURE/packages/pkg-b/package.json" <<'EOF'
{
  "name": "@fixture/pkg-b",
  "private": true,
  "scripts": { "build": "node -e \"require('fs').writeFileSync('built.marker','1')\"" }
}
EOF

(
  cd "$FIXTURE"
  git_clean_env init -q
  git_clean_env config user.email "test@test.local"
  git_clean_env config user.name "test"
  corepack prepare pnpm@9.15.4 --activate >/dev/null 2>&1
  pnpm install --no-frozen-lockfile >/dev/null 2>&1
  git_clean_env add -A
  git_clean_env commit -q -m "fixture"
)
FIXTURE_COMMIT="$(cd "$FIXTURE" && git_clean_env rev-parse HEAD)"
[[ "$FIXTURE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "could not create the fixture repo's commit"

# --- Case (a): no --exclude-package -> --dry-run output is unchanged ------
DEST_A="$WORKDIR/dest-a"
OUT_A="$("$BUILD_RELEASE_SH" --commit "$FIXTURE_COMMIT" --dest "$DEST_A" --repo-src "$FIXTURE" --dry-run 2>&1)"
echo "$OUT_A" | grep -qF "[dry-run] would run in $DEST_A: pnpm install --frozen-lockfile" \
  || fail "Case (a): expected the unchanged 'pnpm install --frozen-lockfile' dry-run line, not found. Output:
$OUT_A"
echo "$OUT_A" | grep -qF "[dry-run] would run in $DEST_A: pnpm run build" \
  || fail "Case (a): expected the unchanged plain 'pnpm run build' dry-run line, not found. Output:
$OUT_A"
if echo "$OUT_A" | grep -q -- '--filter\|preflight:workspace-links'; then
  fail "Case (a): --dry-run output changed with no --exclude-package given (found --filter or a separate preflight line). Output:
$OUT_A"
fi
echo "PASS: build-release.sh --dry-run with no --exclude-package is unchanged (plain 'pnpm run build')"

# --- Case (b): --exclude-package actually excludes that package's build --
# Proves the pnpm 9.15.4 negative-filter syntax works for real (not assumed
# from docs): the excluded package's build script must not run, the other
# package's must, and the preflight step must still run.
DEST_B="$WORKDIR/dest-b"
OUT_B="$("$BUILD_RELEASE_SH" --commit "$FIXTURE_COMMIT" --dest "$DEST_B" --repo-src "$FIXTURE" --exclude-package @fixture/pkg-b 2>&1)" \
  || fail "Case (b): build-release.sh exited non-zero with --exclude-package. Output:
$OUT_B"
[[ -f "$DEST_B/preflight.marker" ]] || fail "Case (b): preflight:workspace-links did not run (its marker file is missing) -- the preflight step must still run when excluding a package"
[[ -f "$DEST_B/packages/pkg-a/built.marker" ]] || fail "Case (b): @fixture/pkg-a (not excluded) did not build -- its marker file is missing"
[[ ! -f "$DEST_B/packages/pkg-b/built.marker" ]] || fail "Case (b): @fixture/pkg-b was excluded via --exclude-package but its build script ran anyway -- the pnpm 9.15.4 negative filter did not take effect"
echo "$OUT_B" | grep -qF "Excluding workspace package from the release build (--exclude-package): @fixture/pkg-b" \
  || fail "Case (b): expected a log line naming the excluded package. Output:
$OUT_B"
echo "PASS: --exclude-package <pkg> actually excludes that package's build on pinned pnpm 9.15.4 (preflight still runs, other packages still build)"

# --- Case (c): install-native-zimaos.sh's C-compiler probe ----------------
# full_path_except mirrors the test runner's entire real PATH into one
# flat symlink dir, omitting only the named tools. Unlike curated_path in
# test-drop-priv-helper-fallback.sh (an allow-list -- fine there, because
# that test only needs a handful of named tools), install-native-
# zimaos.sh's --dry-run path shells out to many ambient tools (uname,
# dirname, mkdir, ...), so a deny-list that keeps everything else is what
# lets --dry-run run to completion while still genuinely removing cc/gcc.
full_path_except() {
  local bindir="$WORKDIR/masked-bin.$RANDOM" dir f base excl skip
  mkdir -p "$bindir"
  local -a dirs
  IFS=':' read -ra dirs <<<"$PATH"
  for dir in "${dirs[@]}"; do
    [[ -d "$dir" ]] || continue
    for f in "$dir"/*; do
      [[ -x "$f" && -f "$f" ]] || continue
      base="$(basename "$f")"
      skip=0
      for excl in "$@"; do
        [[ "$base" == "$excl" ]] && { skip=1; break; }
      done
      [[ "$skip" == "1" ]] && continue
      [[ -e "$bindir/$base" ]] || ln -sf "$f" "$bindir/$base"
    done
  done
  printf '%s\n' "$bindir"
}

run_install_dry_run() {
  local masked_path="$1"
  shift
  # -u BASH_ENV: this sandbox resets PATH via a forced profile on every
  # non-interactive bash startup (same issue noted in
  # test-drop-priv-helper-fallback.sh); unset it so the PATH mask holds.
  env -u BASH_ENV "$@" PATH="$masked_path" bash "$INSTALL_SH" \
    --commit "$FIXTURE_COMMIT" --repo-src "$FIXTURE" --dry-run 2>&1
}

# Case (c1): a compiler is on PATH -> resolved and logged, no exclusion.
NORMAL_PATH="$(full_path_except)"
OUT_C1="$(run_install_dry_run "$NORMAL_PATH")" || fail "Case (c1): install-native-zimaos.sh --dry-run failed with a normal PATH. Output:
$OUT_C1"
echo "$OUT_C1" | grep -q "^\[.*\] C compiler resolved: " \
  || fail "Case (c1): expected a 'C compiler resolved: ...' line with a normal PATH. Output:
$OUT_C1"
if echo "$OUT_C1" | grep -q "No C compiler on this host"; then
  fail "Case (c1): host has a compiler on PATH but the probe still reported none. Output:
$OUT_C1"
fi
if echo "$OUT_C1" | grep -q -- "--exclude-package"; then
  fail "Case (c1): --exclude-package was passed to build-release.sh even though a compiler was resolved. Output:
$OUT_C1"
fi
echo "PASS: the C-compiler probe resolves and logs a compiler when one is on PATH, and passes no exclusion"

# Case (c2): no cc or gcc on PATH, and no $CC set -> excludes the broker,
# visibly, in --dry-run output.
NO_COMPILER_PATH="$(full_path_except cc gcc)"
if PATH="$NO_COMPILER_PATH" command -v cc >/dev/null 2>&1 || PATH="$NO_COMPILER_PATH" command -v gcc >/dev/null 2>&1; then
  fail "Case (c2): cc/gcc are still resolvable under the masked PATH -- the test setup did not actually mask them"
fi
OUT_C2="$(run_install_dry_run "$NO_COMPILER_PATH" -u CC)" || fail "Case (c2): install-native-zimaos.sh --dry-run failed with no compiler on PATH. Output:
$OUT_C2"
echo "$OUT_C2" | grep -qF "No C compiler on this host; excluding @paperclipai/tailscale-https-broker from the release build" \
  || fail "Case (c2): expected the no-compiler exclusion line naming the broker package. Output:
$OUT_C2"
echo "$OUT_C2" | grep -qF -- "--exclude-package @paperclipai/tailscale-https-broker" \
  || fail "Case (c2): expected --exclude-package @paperclipai/tailscale-https-broker to be visible in the --dry-run build-release.sh invocation. Output:
$OUT_C2"
echo "PASS: the C-compiler probe excludes the broker package, visibly in --dry-run output, when no compiler is on PATH"

# Case (c3): \$CC set to a resolvable path is preferred over cc/gcc.
CC_DIR="$WORKDIR/cc-dir"
mkdir -p "$CC_DIR"
cat > "$CC_DIR/my-custom-cc" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$CC_DIR/my-custom-cc"
WITH_CUSTOM_CC_PATH="$(full_path_except)"
WITH_CUSTOM_CC_PATH="$CC_DIR:$WITH_CUSTOM_CC_PATH"
OUT_C3="$(env -u BASH_ENV CC="$CC_DIR/my-custom-cc" PATH="$WITH_CUSTOM_CC_PATH" bash "$INSTALL_SH" --commit "$FIXTURE_COMMIT" --repo-src "$FIXTURE" --dry-run 2>&1)" \
  || fail "Case (c3): install-native-zimaos.sh --dry-run failed with \$CC set. Output:
$OUT_C3"
echo "$OUT_C3" | grep -qF "C compiler resolved: $CC_DIR/my-custom-cc" \
  || fail "Case (c3): expected \$CC to be resolved and reported ahead of cc/gcc. Output:
$OUT_C3"
echo "PASS: \$CC, when set and resolvable, is preferred over cc/gcc"

# --- Case (d): paperclip-update.sh uses the same shared probe ------------
# paperclip-update.sh's --dry-run needs no --root (ROOT defaults to a path
# that is never touched under --dry-run) and no systemd/DB tooling on
# PATH -- require_root/require_cmd are both gated on DRY_RUN != 1 -- so the
# same PATH-masking approach as case (c) works unchanged here.
run_update_dry_run() {
  local masked_path="$1"
  shift
  env -u BASH_ENV "$@" PATH="$masked_path" bash "$UPDATE_SH" \
    --commit "$FIXTURE_COMMIT" --repo-src "$FIXTURE" --dry-run 2>&1
}

# Case (d1): a compiler is on PATH -> resolved and logged, no exclusion.
OUT_D1="$(run_update_dry_run "$NORMAL_PATH")" || fail "Case (d1): paperclip-update.sh --dry-run failed with a normal PATH. Output:
$OUT_D1"
echo "$OUT_D1" | grep -q "^\[.*\] C compiler resolved: " \
  || fail "Case (d1): expected a 'C compiler resolved: ...' line with a normal PATH. Output:
$OUT_D1"
if echo "$OUT_D1" | grep -q -- "--exclude-package"; then
  fail "Case (d1): --exclude-package was passed to build-release.sh even though a compiler was resolved. Output:
$OUT_D1"
fi
echo "PASS: paperclip-update.sh's C-compiler probe resolves and logs a compiler when one is on PATH, and passes no exclusion"

# Case (d2): no cc or gcc on PATH, and no $CC set -> excludes the broker,
# visibly, in --dry-run output.
OUT_D2="$(run_update_dry_run "$NO_COMPILER_PATH" -u CC)" || fail "Case (d2): paperclip-update.sh --dry-run failed with no compiler on PATH. Output:
$OUT_D2"
echo "$OUT_D2" | grep -qF "No C compiler on this host; excluding @paperclipai/tailscale-https-broker from the release build" \
  || fail "Case (d2): expected the no-compiler exclusion line naming the broker package. Output:
$OUT_D2"
echo "$OUT_D2" | grep -qF -- "--exclude-package @paperclipai/tailscale-https-broker" \
  || fail "Case (d2): expected --exclude-package @paperclipai/tailscale-https-broker to be visible in the --dry-run build-release.sh invocation. Output:
$OUT_D2"
echo "PASS: paperclip-update.sh's C-compiler probe excludes the broker package, visibly in --dry-run output, when no compiler is on PATH"

echo "All exclude-broker/no-compiler test cases passed."
