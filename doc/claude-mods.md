# Claude Code mods for Paperclip Claude agents

Paperclip can load Claude Code mods (function-hooks plugins) into every
`claude_local` agent run. The wiring lives in
`server/src/adapters/claude-mods.ts` and is applied in
`server/src/adapters/registry.ts`.

## Why an environment variable

Paperclip's Claude agents run through the ACP engine, which spawns the agent
binary itself and takes no `--plugin-dir` flag. `CLAUDE_CODE_PLUGIN_DIRS` is
honoured by both the Claude CLI and the agent SDK binary, so the wrapper merges
it into `config.env` — the env the adapter forwards into the spawned process —
exactly as `stampClaudeAgentIdHeader` does for its header.

Setting the variable per agent in `adapterConfig.env` is not an alternative for
an agent-authenticated caller: `assertNoAgentLocalAdapterHostCommandMutation` in
`server/src/routes/agents.ts` refuses an agent key that writes `env` on a
`*_local` adapter, and the environments routes require board access.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PAPERCLIP_CLAUDE_MOD_DIRS` | `/paperclip/mods/audit-trail` | `:`-separated plugin directories loaded for every Claude agent run. Set it to an empty string to load no mods. |
| `PAPERCLIP_CLAUDE_AUDIT_TRAIL_DIR` | `/paperclip/storage/audit-trail` | Where the `audit-trail` mod writes its JSONL logs. |
| `PAPERCLIP_CLAUDE_AUDIT_TRAIL_RETENTION_DAYS` | `14` | Age at which an audit-trail log is deleted. |

A directory that does not exist on disk is skipped, and when no configured
directory exists the wrapper forwards the execution context untouched. A
Paperclip install without `/paperclip/mods` therefore behaves as it did before.

A value already present in `config.env` wins: an operator who sets
`CLAUDE_CODE_PLUGIN_DIRS` or `CLAUDE_AUDIT_TRAIL_DIR` on an agent keeps it, and
the configured mod directories are appended rather than replacing the list.

## Retention

Audit-trail logs are swept on an agent run, at most once every six hours, by
`pruneAuditTrail`. It deletes `*.jsonl` files whose mtime is older than the
retention window and ignores everything else in the folder. The sweep never
throws: losing a log is preferable to failing an agent run.

## Adding a mod

1. Put the validated plugin directory under `/paperclip/mods/<name>` on the host
   volume (`claude plugin validate <dir>` must pass).
2. Add its path to `PAPERCLIP_CLAUDE_MOD_DIRS`, or to `DEFAULT_MOD_DIRS` in
   `server/src/adapters/claude-mods.ts` when it should be on for every install.
3. Prove it with one real run and read the mod's own output, not the model's
   prose.

Do not point `CLAUDE_CODE_PLUGIN_DIRS` at `/paperclip/mods` itself. Claude Code
treats a folder of plugins as "load every child", which would switch on mods
that were never approved.
