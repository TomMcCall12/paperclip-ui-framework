#!/usr/bin/env bash
# Launch an agent program with the agent OOM score, set BEFORE the program
# starts (TOM-703). The Paperclip server runs at a protected oom_score_adj
# (-500, set by paperclip-oom-guard.sh) and a child inherits that at fork. The
# server starts local agent runs through this wrapper
# (PAPERCLIP_AGENT_EXEC_WRAPPER, set by the 50-oom-guard.conf drop-in), so the
# value is reset in the new process before it execs the agent: an agent is
# never more protected than Tailscale and networking (0), not even for the
# first millisecond. paperclip-oom-guard.sh remains as the backstop for
# anything that does not go through here.
#
# Raising oom_score_adj needs no privilege, so this runs as the server's user.
# It fails closed: if the target value is invalid, the current value cannot be
# read, the write is refused while the current value is still below the target,
# or the value read back is below the target, it prints the reason to stderr and
# exits 1 WITHOUT running the program. Running the agent anyway would hand it
# the server's protected score (the window this wrapper exists to close).
#
# Environment: PAPERCLIP_OOM_AGENT_ADJ (0), PAPERCLIP_OOM_SELF_FILE
# (/proc/self/oom_score_adj; the offline tests point it at a file).
#
# Usage: paperclip-agent-exec.sh <command> [args...]
set -u

if (($# == 0)); then
  echo "usage: paperclip-agent-exec.sh <command> [args...]" >&2
  exit 2
fi

refuse() {
  echo "paperclip-agent-exec: refusing to start '$1': $2" >&2
  exit 1
}

agent_adj="${PAPERCLIP_OOM_AGENT_ADJ:-0}"
self_file="${PAPERCLIP_OOM_SELF_FILE:-/proc/self/oom_score_adj}"
program="$1"

# The kernel range is -1000..1000; bash arithmetic would also misread 08 as octal.
if ! [[ "$agent_adj" =~ ^-?(0|[1-9][0-9]{0,3})$ ]] || ((agent_adj < -1000 || agent_adj > 1000)); then
  refuse "$program" "PAPERCLIP_OOM_AGENT_ADJ='$agent_adj' is not an integer in -1000..1000"
fi

cur=""
{ read -r cur <"$self_file"; } 2>/dev/null || cur=""
[[ "$cur" =~ ^-?(0|[1-9][0-9]{0,3})$ ]] || refuse "$program" "cannot read a numeric oom_score_adj from $self_file"

if ((cur < agent_adj)); then
  { printf '%s\n' "$agent_adj" >"$self_file"; } 2>/dev/null || true
  after=""
  { read -r after <"$self_file"; } 2>/dev/null || after=""
  [[ "$after" =~ ^-?(0|[1-9][0-9]{0,3})$ ]] || refuse "$program" "cannot read oom_score_adj back from $self_file after the write"
  ((after >= agent_adj)) || refuse "$program" "oom_score_adj is $after, below the required $agent_adj; the write to $self_file was refused"
fi
unset agent_adj self_file cur after program
exec "$@"
