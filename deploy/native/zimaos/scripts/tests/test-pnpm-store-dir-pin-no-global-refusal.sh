#!/usr/bin/env bash
# Offline test for TOM-288: pnpm refuses ANY --global config write when its
# global bin directory (PNPM_HOME) is absent from PATH. The real board run
# hit this at install-native-zimaos.sh's "pin pnpm's store-dir" step:
# BUILD_ENV set PNPM_HOME but never put it on PATH, and the step pinned the
# store via `corepack pnpm config set store-dir ... --global`, which pnpm
# refused outright (exit 1, "is not in PATH").
#
# The fix is two independent things, both proven here:
#   (a) BUILD_ENV's PATH now includes PNPM_HOME (after the pinned Node
#       toolchain's bin dir, which must stay first) -- so that refusal can
#       never recur even if a future --global call is added to this step.
#   (b) The store-dir pin itself no longer does a --global config write at
#       all: it goes through PNPM_CONFIG_STORE_DIR, a plain env var in
#       BUILD_ENV that every pnpm invocation inheriting it (including
#       build-release.sh's `pnpm install`/`pnpm run build`) picks up with no
#       global config file written anywhere.
#
# This test evals BUILD_ENV's literal definition straight out of
# install-native-zimaos.sh (not a re-typed copy), so it tracks the real
# script and fails the moment PNPM_HOME drops off PATH again. It then
# proves (a) and (b) behaviorally against the real corepack-managed pnpm
# this install activates -- not assumed from pnpm's docs -- using the system
# Node/corepack as a stand-in for the downloaded toolchain (no network, no
# root needed for that part; the npm registry call below needs network,
# same as the existing exclude-broker test's `corepack prepare` does).
#
# Usage: test-pnpm-store-dir-pin-no-global-refusal.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIMAOS_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
NATIVE_DIR="$(cd "$ZIMAOS_DIR/.." && pwd)"
INSTALL_SH="$ZIMAOS_DIR/install-native-zimaos.sh"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(make_exec_capable_tempdir paperclip-pnpm-store-dir-test "$NATIVE_DIR")"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

ROOT="$WORKDIR/root"
mkdir -p "$ROOT/toolchain/node/bin" "$ROOT/home/.tmp" "$ROOT/home/.cache/npm" \
  "$ROOT/home/.config" "$ROOT/home/.local/share/pnpm/store" "$ROOT/home/.local/state"

# Stand in for the real downloaded-and-SHA-verified Node toolchain with the
# system one -- this test only needs a working node+corepack, not the real
# download/verify step (covered elsewhere).
ln -sf "$(command -v node)" "$ROOT/toolchain/node/bin/node"
ln -sf "$(command -v corepack)" "$ROOT/toolchain/node/bin/corepack"

# --- Pull BUILD_ENV's literal definition out of the real script -----------
# This is the actual production array, evaluated with this test's $ROOT and
# ambient $PATH -- not a re-typed copy that could drift from the source.
# Any assignment the BUILD_ENV=( ... ) block itself depends on (e.g.
# PNPM_HOME_DIR) is picked up too, if present -- harmless no-op if a given
# revision of the script has no such line, which keeps this test meaningful
# against both the pre-fix and the fixed script shape.
PNPM_HOME_DIR_LINE="$(grep -E '^PNPM_HOME_DIR=' "$INSTALL_SH" || true)"
BUILD_ENV_ARRAY_BLOCK="$(sed -n '/^BUILD_ENV=(/,/^)/p' "$INSTALL_SH")"
[[ -n "$BUILD_ENV_ARRAY_BLOCK" ]] || fail "could not find 'BUILD_ENV=( ... )' in $INSTALL_SH"
BUILD_ENV_BLOCK="$PNPM_HOME_DIR_LINE
$BUILD_ENV_ARRAY_BLOCK"
eval "$BUILD_ENV_BLOCK"

PNPM_HOME_VALUE=""
PATH_VALUE=""
for entry in "${BUILD_ENV[@]}"; do
  case "$entry" in
    PNPM_HOME=*) PNPM_HOME_VALUE="${entry#PNPM_HOME=}" ;;
    PATH=*) PATH_VALUE="${entry#PATH=}" ;;
  esac
done
[[ -n "$PNPM_HOME_VALUE" ]] || fail "BUILD_ENV has no PNPM_HOME entry"
[[ -n "$PATH_VALUE" ]] || fail "BUILD_ENV has no PATH entry"

path_has_entry() {
  local needle="$1" p
  local -a parts
  IFS=':' read -ra parts <<<"$PATH_VALUE"
  for p in "${parts[@]}"; do
    [[ "$p" == "$needle" ]] && return 0
  done
  return 1
}

# --- (a): PNPM_HOME must be in BUILD_ENV's constructed PATH ---------------
path_has_entry "$PNPM_HOME_VALUE" \
  || fail "PNPM_HOME ($PNPM_HOME_VALUE) is not in BUILD_ENV's PATH ($PATH_VALUE) -- pnpm will refuse any --global config write with 'is not in PATH', exactly as it did on the real board"
echo "PASS: PNPM_HOME is present in BUILD_ENV's constructed PATH"

first_entry="${PATH_VALUE%%:*}"
[[ "$first_entry" == "$ROOT/toolchain/node/bin" ]] \
  || fail "the pinned Node toolchain's bin dir is not first on BUILD_ENV's PATH (got: $first_entry) -- it must stay first so the pinned node/corepack/pnpm resolve ahead of anything else on PATH"
echo "PASS: \$ROOT/toolchain/node/bin stays first on BUILD_ENV's PATH"

# --- (b): no --global pnpm config write remains in the installer ----------
if grep -nE 'pnpm[[:space:]]+config[[:space:]]+set[[:space:]]+store-dir.*--global' "$INSTALL_SH"; then
  fail "install-native-zimaos.sh still runs a --global pnpm config write for store-dir"
fi
echo "PASS: install-native-zimaos.sh no longer writes a global pnpm config for store-dir"

# --- Behavioral proof of (a): the real refusal is actually cleared --------
# Reproduces the exact TOM-288 failure mode -- pnpm refusing ANY --global
# config write when PNPM_HOME is absent from PATH -- and proves BUILD_ENV's
# PATH clears it for real, against the exact corepack-managed pnpm this
# install activates.
env "${BUILD_ENV[@]}" "$ROOT/toolchain/node/bin/corepack" enable >/dev/null 2>&1 \
  || fail "corepack enable failed with the constructed BUILD_ENV"
GLOBAL_WRITE_OUT="$(env "${BUILD_ENV[@]}" "$ROOT/toolchain/node/bin/corepack" pnpm config set store-dir "$PNPM_HOME_VALUE/store" --global 2>&1)" \
  || fail "a --global pnpm config write still fails with the constructed BUILD_ENV (this is the exact TOM-288 refusal). Output:
$GLOBAL_WRITE_OUT"
echo "PASS: with BUILD_ENV's PATH, a --global pnpm config write no longer hits the 'not in PATH' refusal"

# --- Behavioral proof of (b): the store resolves under <root> with no global write ---
CONFIG_FILES_BEFORE="$(find "$ROOT/home/.config" -type f 2>/dev/null | wc -l)"
STORE_PATH_OUT="$(env "${BUILD_ENV[@]}" "$ROOT/toolchain/node/bin/corepack" pnpm store path 2>&1)" \
  || fail "pnpm store path failed with the constructed BUILD_ENV. Output:
$STORE_PATH_OUT"
CONFIG_FILES_AFTER="$(find "$ROOT/home/.config" -type f 2>/dev/null | wc -l)"
[[ "$CONFIG_FILES_BEFORE" == "$CONFIG_FILES_AFTER" ]] \
  || fail "pnpm store path wrote a new file under XDG_CONFIG_HOME ($ROOT/home/.config) -- expected no global pnpm config write at all"
echo "$STORE_PATH_OUT" | grep -qF "$PNPM_HOME_VALUE/store" \
  || fail "pnpm's resolved store path does not land under PNPM_HOME/store as BUILD_ENV pins it via PNPM_CONFIG_STORE_DIR. Got:
$STORE_PATH_OUT"
echo "PASS: pnpm's store resolves under <root> via PNPM_CONFIG_STORE_DIR, with no global pnpm config file written"

echo "All PNPM_HOME/PATH + no-global-store-dir-write test cases passed."
