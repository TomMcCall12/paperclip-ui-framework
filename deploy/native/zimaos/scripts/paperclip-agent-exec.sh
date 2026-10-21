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
# If the write fails the program still starts (the guard resets it).
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

agent_adj="${PAPERCLIP_OOM_AGENT_ADJ:-0}"
self_file="${PAPERCLIP_OOM_SELF_FILE:-/proc/self/oom_score_adj}"
cur=""
{ read -r cur <"$self_file"; } 2>/dev/null || cur=""
if [[ "$agent_adj" =~ ^-?[0-9]+$ && "$cur" =~ ^-?[0-9]+$ ]] && ((cur < agent_adj)); then
  printf '%s\n' "$agent_adj" >"$self_file" 2>/dev/null || true
fi
unset agent_adj self_file cur
exec "$@"
