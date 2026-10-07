# Notes vault

A notes vault is a folder of Markdown notes, such as an Obsidian vault, that chosen agents can read and write through Paperclip. It works the same whatever model or adapter the agent runs on: Claude Code, Codex, a Hermes gateway agent or any future provider. Agents call the Paperclip API with their usual credentials.

## Design

- **Only the bridge sees the vault.** The vault is mounted into a small `notes-vault-bridge` container, never into the Paperclip container. Agent processes run in the Paperclip container as the same OS user as the server, so a vault mounted there would be writable by every local agent with a shell, which would skip the rules below.
- **Paperclip decides who may act.** The server checks the caller, enforces the rules, then calls the bridge with a token only it holds. The bridge re-checks paths and does the file work.
- **Access is operator configuration.** Readers and writers are listed by agent id in the server environment, bound to one company. No agent can grant itself access, not even a CEO. An agent keeps its id when its model or adapter changes, so its access survives that change.
- **Threat model.** This protects the vault from agents using their normal tools. An agent that deliberately reads the server's memory or environment could take the bridge token. Local agents can already reach the Paperclip database the same way, so this adds no new exposure.

## Rules

| Rule | Enforced by |
|---|---|
| Paths are relative to the vault. No `..`, absolute paths or hidden folders (`.obsidian`, `.trash`, `.git`), and no symlink escapes. | bridge |
| Only Markdown (`.md`) files can be written. | server |
| `create` never overwrites an existing file. | bridge |
| `replace` needs `baseSha256` from the caller's latest read and fails if the file changed since. | server and bridge |
| Agent-created files must start with the AI prefix, `(C) ` by default. | server |
| Every write appends one row to the changelog: `\| date \| path \| summary \| actor \|`. Nobody can write the changelog directly. | bridge |
| Every write is recorded in the activity log as `notes_vault.file_written` with the path, mode and hashes, but not the content. | server |

## API

All routes are company-scoped. If the caller has no vault access, the status route reports `enabled: false` and the other routes return 404.

| Method and path | Purpose |
|---|---|
| `GET /api/companies/{companyId}/notes-vault` | Status: `enabled`, `access` (`none`, `read` or `write`), `aiFilePrefix` and `changelogPath`. |
| `GET /api/companies/{companyId}/notes-vault/list?path=<folder>` | List a folder. Hidden entries are left out. |
| `GET /api/companies/{companyId}/notes-vault/file?path=<file>` | Read a file. Returns `content`, `sha256` and `bytes`. |
| `POST /api/companies/{companyId}/notes-vault/file` | Write a file. Body: `{ path, mode: "create" \| "append" \| "replace", content, baseSha256?, summary }`. |
| `GET /api/companies/{companyId}/notes-vault/sync` | Readers: status of the two-way sync with the vault's cloud copy: `enabled`, `running`, `lastSuccessAt`, `lastOk`, `lastError`, `lastConflicts`, `nextRunAt`. |
| `POST /api/companies/{companyId}/notes-vault/sync` | Writers: sync now instead of at the next scheduled time. Returns 202 with the status, or 409 when no cloud copy is set up. Logged as `notes_vault.sync_requested`. |

## Setup

1. Add the bridge service from `docker/notes-vault-bridge/docker-compose.example.yml` and mount the vault into it. It runs as root with only file-permission capabilities (`DAC_OVERRIDE`, `CHOWN`, `FOWNER`), sees nothing but the vault and its own script, and gives new files and folders to `VAULT_OWNER_UID`/`VAULT_OWNER_GID`. Existing files keep their owner and mode.
2. Set these variables on the `paperclip` service:

   | Variable | Value |
   |---|---|
   | `PAPERCLIP_NOTES_VAULT_BRIDGE_URL` | `http://notes-vault-bridge:8787` |
   | `PAPERCLIP_NOTES_VAULT_BRIDGE_TOKEN` | The same long random token the bridge uses. |
   | `PAPERCLIP_NOTES_VAULT_COMPANY_ID` | The company the vault belongs to. |
   | `PAPERCLIP_NOTES_VAULT_WRITER_AGENT_IDS` | Comma-separated agent ids that may read and write. |
   | `PAPERCLIP_NOTES_VAULT_READER_AGENT_IDS` | Optional. Comma-separated agent ids that may only read. |
   | `PAPERCLIP_NOTES_VAULT_AI_FILE_PREFIX` | Optional. Defaults to `(C) `; set it empty to drop the prefix rule. |
   | `PAPERCLIP_NOTES_VAULT_CHANGELOG_PATH` | Optional. Defaults to `vault-changelog.md`. |

3. Give the writing agents the `notes-vault` skill so they know the API and the rules.

## Two-way sync with a cloud copy (optional)

People often open the vault on their own devices from a cloud folder, for example a Google Drive folder that Obsidian opens on a computer. The bridge can keep that copy and the vault in step, both ways, with [`rclone bisync`](https://rclone.org/bisync/):

- **Schedule.** It syncs every 5 minutes, and 30 seconds after any write through the bridge.
- **Both sides keep their changes.** A file changed on only one side is copied to the other. If the same file changed on both sides, the newer version wins and the other is kept beside it as `name.sync-conflict1.md`.
- **Deletes are copied too.** rclone stops any run that would delete more than half the files on one side (for example when a mount is empty) and reports the error in the sync status. Nothing is deleted then. An operator runs that sync by hand with `--force` once they have checked it.
- **First sync.** The first run, and any recovery after a failed run, merges both sides. Nothing is deleted then, and where both copies of a file differ, the newer one wins.
- **Ownership.** Files the sync creates are given to `VAULT_OWNER_UID`/`VAULT_OWNER_GID`, like files written through the API.

To turn it on, give the bridge an rclone remote for the cloud folder:

| Bridge variable | Value |
|---|---|
| `VAULT_SYNC_REMOTE` | rclone remote and folder, for example `gdrive:My Vault`. Sync is off when unset. |
| `VAULT_SYNC_CONFIG` | rclone config file with that remote. It must be writable, because rclone saves refreshed tokens. |
| `VAULT_SYNC_STATE_DIR` | Writable folder for bisync's listings, cache and lock. Keep it across restarts. |
| `VAULT_SYNC_RCLONE` | Optional. The rclone binary (default `rclone`); a static rclone binary can be mounted read-only. |
| `VAULT_SYNC_INTERVAL_SEC` / `VAULT_SYNC_AFTER_WRITE_SEC` | Optional. Default 300 and 30. |

Only the bridge holds the rclone config, so agents never see the cloud account's token.
