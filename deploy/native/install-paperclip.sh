#!/usr/bin/env bash
# Install Paperclip (Tom's Lab) natively onto the Debian system bootstrap-
# debian.sh just installed. Creates the paperclip system user, the
# /srv/paperclip release layout, installs Node 24 + pnpm, builds the given
# commit, and restores the data directory (embedded Postgres + secret key)
# from a given source path.
#
# Usage:
#   install-paperclip.sh --commit <sha> --data-src <path> \
#     [--repo-url <url>] [--dry-run]
#
# --data-src must point at a directory shaped like the existing
# ~/.paperclip/instances/default/ tree (db/, data/, secrets/master.key, ...).
# Its contents are copied, never moved, so the source backup stays intact.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

DRY_RUN=0
COMMIT=""
DATA_SRC=""
REPO_URL="https://github.com/TomMcCall12/toms-lab.git"
PAPERCLIP_USER="paperclip"
SRV_ROOT="/srv/paperclip"
HDD_ROOT="/srv/hdd"
NODE_MAJOR="24"

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --data-src) DATA_SRC="$2"; shift 2 ;;
    --repo-url) REPO_URL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$COMMIT" ]] || die "Give --commit <sha> (the exact live commit to build)."
[[ "$COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || die "--commit must be a hex git sha (got: $COMMIT)"
[[ -n "$DATA_SRC" ]] || die "Give --data-src <path> to restore the data directory from."
if [[ "$DRY_RUN" != "1" ]]; then
  [[ -d "$DATA_SRC" ]] || die "--data-src '$DATA_SRC' is not a directory."
fi

if [[ "$DRY_RUN" != "1" ]]; then
  require_root
  require_cmd git corepack rsync runuser getent
fi

log "== System user: $PAPERCLIP_USER, passwordless sudo, owner of $SRV_ROOT and $HDD_ROOT =="
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would create group/user '$PAPERCLIP_USER' (system account, home $SRV_ROOT) if missing"
else
  if ! getent group "$PAPERCLIP_USER" >/dev/null; then
    run "Create group $PAPERCLIP_USER" -- groupadd --system "$PAPERCLIP_USER"
  fi
  if ! getent passwd "$PAPERCLIP_USER" >/dev/null; then
    run "Create system user $PAPERCLIP_USER" -- useradd --system --gid "$PAPERCLIP_USER" \
      --home-dir "$SRV_ROOT" --shell /usr/sbin/nologin --create-home "$PAPERCLIP_USER"
  fi
fi
SUDOERS_LINE="$PAPERCLIP_USER ALL=(ALL) NOPASSWD:ALL"
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would write /etc/sudoers.d/$PAPERCLIP_USER: $SUDOERS_LINE"
else
  log "Writing /etc/sudoers.d/$PAPERCLIP_USER"
  printf '%s\n' "$SUDOERS_LINE" > "/etc/sudoers.d/$PAPERCLIP_USER"
  chmod 440 "/etc/sudoers.d/$PAPERCLIP_USER"
  visudo -cf "/etc/sudoers.d/$PAPERCLIP_USER" || die "Generated sudoers file failed validation"
fi

run "Create $SRV_ROOT" -- mkdir -p "$SRV_ROOT/releases" "$SRV_ROOT/data" "$SRV_ROOT/env"
run "Create $HDD_ROOT" -- mkdir -p "$HDD_ROOT"
run "Own $SRV_ROOT as $PAPERCLIP_USER" -- chown -R "$PAPERCLIP_USER:$PAPERCLIP_USER" "$SRV_ROOT"
run "Own $HDD_ROOT as $PAPERCLIP_USER (top level only; existing contents keep their owners)" -- \
  chown "$PAPERCLIP_USER:$PAPERCLIP_USER" "$HDD_ROOT"

log "== Node $NODE_MAJOR + pnpm =="
CURRENT_NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] would install NodeSource's Node $NODE_MAJOR.x if node -v isn't already v$NODE_MAJOR.*"
else
  if [[ "$CURRENT_NODE_MAJOR" != "$NODE_MAJOR" ]]; then
    run "Fetch the NodeSource setup script for Node $NODE_MAJOR.x" -- \
      curl -fsSL -o /tmp/nodesource_setup.sh "https://deb.nodesource.com/setup_${NODE_MAJOR}.x"
    run "Run the NodeSource setup script" -- bash /tmp/nodesource_setup.sh
    run "Install nodejs" -- apt-get install -y nodejs
    rm -f /tmp/nodesource_setup.sh
  else
    log "Node v$CURRENT_NODE_MAJOR already installed, skipping."
  fi
fi

log "== Release: build commit $COMMIT at $SRV_ROOT/releases/$COMMIT =="
RELEASE_DIR="$SRV_ROOT/releases/$COMMIT"
if [[ "$DRY_RUN" == "1" ]]; then
  "$SCRIPT_DIR/scripts/build-release.sh" --commit "$COMMIT" --dest "$RELEASE_DIR" --repo-url "$REPO_URL" --dry-run
else
  run "Build release $COMMIT as $PAPERCLIP_USER" -- runuser -u "$PAPERCLIP_USER" -- \
    "$SCRIPT_DIR/scripts/build-release.sh" --commit "$COMMIT" --dest "$RELEASE_DIR" --repo-url "$REPO_URL"
fi

log "== Restore data directory from $DATA_SRC (embedded Postgres db/, secrets/master.key) =="
run "Copy $DATA_SRC into $SRV_ROOT/data" -- rsync -a "$DATA_SRC"/ "$SRV_ROOT/data/"
run "Own restored data as $PAPERCLIP_USER" -- chown -R "$PAPERCLIP_USER:$PAPERCLIP_USER" "$SRV_ROOT/data"
if [[ "$DRY_RUN" != "1" ]]; then
  [[ -d "$SRV_ROOT/data/db" ]] || log "WARNING: $SRV_ROOT/data/db not found after restore; embedded Postgres has no data yet."
  [[ -f "$SRV_ROOT/data/secrets/master.key" ]] || log "WARNING: $SRV_ROOT/data/secrets/master.key not found after restore; secrets will not decrypt."
else
  log "[dry-run] would warn if $SRV_ROOT/data/db or $SRV_ROOT/data/secrets/master.key are missing after restore"
fi

log "== Point 'current' at the new release =="
run "Symlink $SRV_ROOT/current -> $RELEASE_DIR" -- ln -sfn "$RELEASE_DIR" "$SRV_ROOT/current"
run "Own the 'current' symlink as $PAPERCLIP_USER" -- chown -h "$PAPERCLIP_USER:$PAPERCLIP_USER" "$SRV_ROOT/current"

log "== Environment file placeholders =="
for env_file in paperclip.env telegram.env notes-vault-bridge.env; do
  dest="$SRV_ROOT/env/$env_file"
  src="$SCRIPT_DIR/env/${env_file}.example"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] would copy $src -> $dest if it doesn't exist yet (never overwrite real secrets)"
  elif [[ -f "$dest" ]]; then
    log "$dest already exists, leaving it alone."
  else
    run "Seed $dest from the example template" -- install -m 600 -o "$PAPERCLIP_USER" -g "$PAPERCLIP_USER" "$src" "$dest"
  fi
done

log "Done. $SRV_ROOT/current -> $RELEASE_DIR. Fill in $SRV_ROOT/env/*.env, then install the"
log "systemd units from deploy/native/systemd/ and start paperclip.service."
