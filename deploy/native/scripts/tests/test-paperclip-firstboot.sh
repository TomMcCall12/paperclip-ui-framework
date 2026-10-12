#!/usr/bin/env bash
# Offline test for paperclip-firstboot.sh (TOM-224). Shadows curl, systemctl
# and journalctl with bash functions (not PATH stubs -- some sandboxes
# reset PATH before running a command, and function lookup always wins
# over PATH regardless) so the real script runs unmodified against a fake
# health endpoint and a fake ESP directory. No real network, systemd, or
# reboot ever happens. Proves all three required branches:
#   1. healthy                      -> records success, disables the unit,
#                                       never reboots
#   2. unhealthy but running        -> records failure, reboots (curl
#                                       always times out)
#   3. never starts at all          -> records failure, reboots (curl:
#                                       connection refused)
# The reboot branch is proven by asserting on the recorded `systemctl
# reboot` invocation, never by actually rebooting anything.
#
# Usage: test-paperclip-firstboot.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
FIRSTBOOT="$SCRIPTS_DIR/paperclip-firstboot.sh"
# shellcheck source=../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-firstboot-test.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# run_case <name> <curl_exit_code> <expect_outcome> <expect_systemctl_cmd>
run_case() {
  local case_name="$1" curl_exit_code="$2" expect_outcome="$3" expect_systemctl_cmd="$4"

  local case_dir="$WORKDIR/$case_name"
  local esp_dir="$case_dir/esp"
  local systemctl_log="$case_dir/systemctl.log"
  mkdir -p "$esp_dir"
  : > "$systemctl_log"
  local status_file="$esp_dir/paperclip-firstboot-status.txt"

  # Run in a subshell: the shadow functions and `source`-ing the real
  # script (so its own `exit` calls only end this subshell) stay isolated
  # from the rest of this test runner.
  (
    # shellcheck disable=SC2317  # invoked indirectly by the sourced script below
    curl() { return "$CURL_EXIT_CODE"; }
    # shellcheck disable=SC2317  # invoked indirectly by the sourced script below
    systemctl() { printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"; [[ "$1" == "is-active" ]] && echo active; return 0; }
    # shellcheck disable=SC2317  # invoked indirectly by the sourced script below
    journalctl() { echo "(fake journal output)"; return 0; }

    export CURL_EXIT_CODE="$curl_exit_code"
    export SYSTEMCTL_LOG="$systemctl_log"
    export ESP_MOUNT="$esp_dir"
    export FIRSTBOOT_TEST_DEADLINE_SECONDS=2
    export FIRSTBOOT_TEST_POLL_INTERVAL_SECONDS=1
    export FIRSTBOOT_TEST_CURL_MAX_TIME=1

    # shellcheck disable=SC1090
    source "$FIRSTBOOT"
  ) > "$case_dir/stdout.log" 2>&1 || true

  [[ -f "$status_file" ]] || { cat "$case_dir/stdout.log" >&2; fail "$case_name: status file was never written at $status_file"; }

  local outcome
  outcome="$(grep -m1 '^outcome=' "$status_file" | cut -d= -f2)"
  [[ "$outcome" == "$expect_outcome" ]] \
    || { cat "$status_file" >&2; fail "$case_name: expected outcome=$expect_outcome, got outcome=$outcome"; }

  if [[ -n "$expect_systemctl_cmd" ]]; then
    grep -qF "$expect_systemctl_cmd" "$systemctl_log" \
      || { cat "$systemctl_log" >&2; fail "$case_name: expected systemctl invocation '$expect_systemctl_cmd' not recorded"; }
  fi

  if [[ "$expect_outcome" == "success" ]]; then
    grep -q '^reboot$' "$systemctl_log" \
      && fail "$case_name: healthy branch must never call systemctl reboot"
  fi

  echo "PASS: $case_name (outcome=$outcome)"
}

# Simulates Paperclip running but never passing health: curl's own
# --max-time elapses (exit 28, operation timeout).
run_case "healthy" 0 "success" "disable paperclip-firstboot.service"
run_case "unhealthy-but-running" 28 "failure" "reboot"
# Simulates Paperclip never starting at all: nothing is listening, curl
# exits 7 (could not connect) every attempt.
run_case "never-starts-connection-refused" 7 "failure" "reboot"

echo "All paperclip-firstboot.sh test cases passed."
