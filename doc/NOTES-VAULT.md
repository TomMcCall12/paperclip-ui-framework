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

## Setup

1. Add the bridge service from `docker/notes-vault-bridge/docker-compose.example.yml`. Mount the vault into it and run it as the user and group that own the vault files.
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
