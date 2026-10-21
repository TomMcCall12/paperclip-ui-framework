#!/usr/bin/env bash
# Offline test for require_build_preflight() (TOM-686): the update must
# refuse to start a build on a host that is already under memory pressure,
# and must clamp the build's MemoryMax so the host keeps its reserve.
#
# Uses fake /proc/meminfo files (PAPERCLIP_MEMINFO_PATH). The first case is
# the real 21 Oct host: 5209MB of 5247MB swap in use, 6468MB available.
#
# Usage: test-build-preflight-swap.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=../../../lib/common.sh
source "$NATIVE_DIR/lib/common.sh"

WORKDIR="$(make_exec_capable_tempdir paperclip-preflight-test "$NATIVE_DIR")"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# fake_meminfo <name> <MemAvailable-MB> <SwapTotal-MB> <SwapUsed-MB>
fake_meminfo() {
  local f="$WORKDIR/$1"
  {
    echo "MemTotal:       16119808 kB"
    echo "MemAvailable:   $(($2 * 1024)) kB"
    echo "SwapTotal:      $(($3 * 1024)) kB"
    echo "SwapFree:       $((($3 - $4) * 1024)) kB"
  } >"$f"
  printf '%s\n' "$f"
}

# preflight <meminfo-file>: runs the pre-flight with the update script's
# defaults (8192MB ceiling, 4096MB reserve, 6144MB minimum, 50% swap) in a
# subshell. Sets PF_RC and PF_OUT (the output ends with the ceiling).
preflight() {
  set +e
  PF_OUT="$(
    export PAPERCLIP_MEMINFO_PATH="$1"
    DRY_RUN=0
    BUILD_MEMORY_MAX_MB=8192
    require_build_preflight "test build" 4096 6144 50 2>&1 && echo "ceiling=$BUILD_MEMORY_MAX_MB"
  )"
  PF_RC=$?
  set -e
}

# 1. The 21 Oct host: swap 99% full -> refuse, and say why.
preflight "$(fake_meminfo oct21 6468 5247 5209)"
[[ "$PF_RC" -ne 0 ]] || fail "the 21 Oct host state (5209/5247MB swap used) was not refused. Output: $PF_OUT"
printf '%s\n' "$PF_OUT" | grep -q "swap is already 5209MB of 5247MB used (99%, limit 50%)" \
  || fail "the refusal does not name the swap use clearly. Output: $PF_OUT"
printf '%s\n' "$PF_OUT" | grep -q "BUILD_EXIT=90-class" || fail "the refusal is not a BUILD_EXIT=90-class failure. Output: $PF_OUT"
echo "PASS: 21 Oct host state (swap 99% full) -> refused with a clear swap message"

# 2. Swap just over the limit, plenty of RAM -> still refused.
preflight "$(fake_meminfo swap51 14000 5000 2560)"
[[ "$PF_RC" -ne 0 ]] || fail "swap at 51% was not refused. Output: $PF_OUT"
echo "PASS: swap 51% used -> refused"

# 3. Swap fine, MemAvailable under reserve + minimum ceiling -> refused.
preflight "$(fake_meminfo lowmem 9000 5247 0)"
[[ "$PF_RC" -ne 0 ]] || fail "9000MB available (< 4096 + 6144) was not refused. Output: $PF_OUT"
printf '%s\n' "$PF_OUT" | grep -q "only 9000MB available, need >= 10240MB" \
  || fail "the low-memory refusal does not give the numbers. Output: $PF_OUT"
echo "PASS: MemAvailable below reserve + minimum build ceiling -> refused with the numbers"

# 4. Healthy host with less than ceiling + reserve -> ceiling clamped so
#    MemAvailable stays >= 4096MB.
preflight "$(fake_meminfo clamp 11000 5247 100)"
[[ "$PF_RC" -eq 0 ]] || fail "a healthy host (11000MB available, swap 2%) was refused. Output: $PF_OUT"
printf '%s\n' "$PF_OUT" | grep -q "ceiling=6904$" || fail "expected the ceiling clamped to 11000 - 4096 = 6904MB. Output: $PF_OUT"
echo "PASS: healthy host -> build ceiling clamped to MemAvailable - reserve (6904MB)"

# 5. Roomy host -> ceiling stays at the configured maximum.
preflight "$(fake_meminfo roomy 14000 5247 0)"
[[ "$PF_RC" -eq 0 ]] || fail "a roomy host was refused. Output: $PF_OUT"
printf '%s\n' "$PF_OUT" | grep -q "ceiling=8192$" || fail "expected the ceiling to stay at 8192MB. Output: $PF_OUT"
echo "PASS: roomy host -> build ceiling stays at --build-memory-max (8192MB)"

# 6. A host with no swap at all is not refused for swap.
preflight "$(fake_meminfo noswap 14000 0 0)"
[[ "$PF_RC" -eq 0 ]] || fail "a host with no swap was refused. Output: $PF_OUT"
echo "PASS: host without swap -> not refused for swap"
