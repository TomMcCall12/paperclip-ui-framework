#!/usr/bin/env bash
# Run every required gate for deploy/native/zimaos/ in one place (TOM-256),
# so a future edit cannot silently drop one of them. Exits non-zero if any
# gate fails; prints every gate's output either way.
#
# Usage: run-gates.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIMAOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE_DIR="$(cd "$ZIMAOS_DIR/.." && pwd)"

status=0

section() { printf '\n=== %s ===\n' "$1"; }

run_gate() {
  local desc="$1"
  shift
  local rc=0
  "$@" || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    printf 'PASS: %s\n' "$desc"
  elif [[ "$rc" -eq 77 && "${PAPERCLIP_REQUIRE_HOST_TESTS:-0}" != "1" ]]; then
    # Exit 77 = needs root and systemd (see test-build-scope-systemd.sh).
    printf 'SKIP: %s (needs root and systemd; run it as root on the host)\n' "$desc"
  else
    printf 'FAIL: %s\n' "$desc"
    status=1
  fi
}

section "shellcheck -x (every script this task added or touched)"
run_gate "shellcheck" shellcheck -x -P SCRIPTDIR \
  "$ZIMAOS_DIR"/install-native-zimaos.sh \
  "$ZIMAOS_DIR"/paperclip-update.sh \
  "$ZIMAOS_DIR"/scripts/*.sh \
  "$ZIMAOS_DIR"/scripts/tests/*.sh \
  "$NATIVE_DIR"/lib/common.sh \
  "$NATIVE_DIR"/paperclip-deploy \
  "$NATIVE_DIR"/scripts/verify-systemd-units.sh \
  "$NATIVE_DIR"/scripts/check-no-early-boot-deps.sh \
  "$NATIVE_DIR"/scripts/check-no-state-outside-run-root.sh

section "Every *.sh file under deploy/native/zimaos starts with a bash shebang"
# Lesson already paid for (TOM-205/TOM-224 class): a shebang-less script
# handed to chroot's exec, or re-exec'd through `/bin/sh` by glibc's
# execvp fallback, fails with an unexplained "[[: not found". This task's
# scripts are invoked directly (never generated-then-chroot-exec'd), but
# asserting the shebang here costs nothing and catches the same mistake
# before it reaches the board.
shebang_ok=1
while IFS= read -r -d '' f; do
  first_line="$(head -n1 "$f")"
  if [[ "$first_line" != "#!/usr/bin/env bash" ]]; then
    printf 'FAIL: %s has no bash shebang as its first line (got: %s)\n' "$f" "$first_line"
    shebang_ok=0
  fi
done < <(find "$ZIMAOS_DIR" -name '*.sh' -print0)
run_gate "bash shebang present on every zimaos script" bash -c "exit $((1 - shebang_ok))"

section "verify-systemd-units.sh --units-dir zimaos/systemd (systemd-analyze verify, drop-ins included)"
run_gate "verify-systemd-units.sh (zimaos)" "$NATIVE_DIR/scripts/verify-systemd-units.sh" --units-dir "$ZIMAOS_DIR/systemd"

section "check-no-early-boot-deps.sh --units-dir zimaos/systemd (units and drop-ins)"
run_gate "check-no-early-boot-deps.sh" "$NATIVE_DIR/scripts/check-no-early-boot-deps.sh" --units-dir "$ZIMAOS_DIR/systemd"

section "check-no-state-outside-run-root.sh (zimaos tree)"
run_gate "check-no-state-outside-run-root.sh" "$NATIVE_DIR/scripts/check-no-state-outside-run-root.sh" "$ZIMAOS_DIR"

section "check-execstart-targets.sh offline tests (shared with the Debian route; pass+fail cases)"
run_gate "test-check-execstart-targets.sh" bash "$NATIVE_DIR/scripts/tests/test-check-execstart-targets.sh"

section "copy_tree/copy_tree_mirror rsync-absent fallback offline test"
run_gate "test-copy-tree-rsync-fallback.sh" bash "$SCRIPT_DIR/tests/test-copy-tree-rsync-fallback.sh"

section "PORT ambient-override offline test"
run_gate "test-port-no-ambient-override.sh" bash "$SCRIPT_DIR/tests/test-port-no-ambient-override.sh"

section "drop-privileges helper (runuser -> setpriv -> su) fallback offline test"
run_gate "test-drop-priv-helper-fallback.sh" bash "$SCRIPT_DIR/tests/test-drop-priv-helper-fallback.sh"

section "drop_priv_run su-branch argument quoting offline test"
run_gate "test-drop-priv-run-quoting.sh" bash "$SCRIPT_DIR/tests/test-drop-priv-run-quoting.sh"

section "recovery-base (/usr/local/lib/paperclip -> <root>/recovery) fallback offline test"
run_gate "test-recovery-base-fallback.sh" bash "$SCRIPT_DIR/tests/test-recovery-base-fallback.sh"

section "build-release.sh --exclude-package + C-compiler probe offline test"
run_gate "test-exclude-broker-no-compiler.sh" bash "$SCRIPT_DIR/tests/test-exclude-broker-no-compiler.sh"

section "PNPM_HOME-in-PATH + no-global-store-dir-write offline test"
run_gate "test-pnpm-store-dir-pin-no-global-refusal.sh" bash "$SCRIPT_DIR/tests/test-pnpm-store-dir-pin-no-global-refusal.sh"

section "memory guard stops the whole build tree offline test (TOM-686)"
run_gate "test-memory-guard-kills-tree.sh" bash "$SCRIPT_DIR/tests/test-memory-guard-kills-tree.sh"

section "build scope fails closed: unverifiable scope, cleanup failure, no ceiling, orphaned scopes (mocked systemd, TOM-686)"
run_gate "test-build-scope-fail-closed.sh" bash "$SCRIPT_DIR/tests/test-build-scope-fail-closed.sh"

section "real systemd build scope: guard trip and SIGKILLed-updater orphan sweep (root only, TOM-686)"
run_gate "test-build-scope-systemd.sh" bash "$SCRIPT_DIR/tests/test-build-scope-systemd.sh"

section "build pre-flight refuses on high swap / low memory offline test (TOM-686)"
run_gate "test-build-preflight-swap.sh" bash "$SCRIPT_DIR/tests/test-build-preflight-swap.sh"

section "paperclip-update.sh exit trap restarts only a down server offline test (TOM-686)"
run_gate "test-update-exit-trap.sh" bash "$SCRIPT_DIR/tests/test-update-exit-trap.sh"

section "recover unit, OOM guard and safety-net install offline test (TOM-686)"
run_gate "test-host-safety-net.sh" bash "$SCRIPT_DIR/tests/test-host-safety-net.sh"

section "recovery-path scripts --dry-run (TOM-686)"
run_gate "paperclip-recover.sh --dry-run" bash -c \
  "PAPERCLIP_NATIVE_ROOT=/nonexistent '$SCRIPT_DIR/paperclip-recover.sh' --dry-run >/dev/null 2>&1"
run_gate "paperclip-oom-guard.sh --dry-run" bash -c "'$SCRIPT_DIR/paperclip-oom-guard.sh' --dry-run >/dev/null 2>&1"

section "install-native-zimaos.sh --dry-run"
run_gate "install-native-zimaos.sh --dry-run" bash -c \
  "'$ZIMAOS_DIR/install-native-zimaos.sh' --commit 0000000 --repo-src '$NATIVE_DIR' --dry-run >/dev/null"

section "paperclip-update.sh --dry-run"
run_gate "paperclip-update.sh --dry-run" bash -c \
  "'$ZIMAOS_DIR/paperclip-update.sh' --commit 0000000 --repo-src '$NATIVE_DIR' --dry-run >/dev/null"

printf '\n'
if [[ "$status" -eq 0 ]]; then
  printf 'All gates passed.\n'
else
  printf 'One or more gates FAILED -- see above.\n'
fi
exit "$status"
