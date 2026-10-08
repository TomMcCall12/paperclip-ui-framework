# Claude Code mods for Paperclip Claude agents

Paperclip can load Claude Code mods (function-hooks plugins) into every
`claude_local` agent run. The wiring lives in
`server/src/adapters/claude-mods.ts` and is applied in
`server/src/adapters/registry.ts`.

## Why an environment variable, and how it actually reaches an ACP session

Paperclip's Claude agents run through the ACP engine, which spawns the agent
binary itself and takes no `--plugin-dir` flag. `CLAUDE_CODE_PLUGIN_DIRS` is
honoured by both the Claude CLI and the agent SDK binary when either is
launched directly, so the wrapper merges it into `config.env` — the env the
adapter forwards into the spawned process — exactly as
`stampClaudeAgentIdHeader` does for its header.

That environment variable alone is **not** enough for an ACP session, because
the ACP engine never launches the CLI directly: it runs
`@agentclientprotocol/claude-agent-acp`, which calls the Claude Agent SDK's
`query()`. `query()` spawns its own bundled binary and loads plugins only
through its `plugins` option (one `--plugin-dir` argv flag per entry); it does
not read `CLAUDE_CODE_PLUGIN_DIRS` from the child's environment. A vendor
patch at `patches/@agentclientprotocol__claude-agent-acp@0.73.0.patch`
translates `CLAUDE_CODE_PLUGIN_DIRS` into that `plugins` option so the
directories this wrapper sets actually reach the spawned process.

Getting the plugin directory loaded is still not enough on its own: the
bundled binary gates a function-hooks plugin's hooks module (the kind
`audit-trail` is — `hooks.json` pointing at a `register.ts` module) behind a
GrowthBook rollout flag (`tengu_plugin_hooks_modules`) that defaults off when
GrowthBook is unreachable or telemetry is opted out. The plugin directory
loads (`plugin.json` and `hooks.json` are read) but its hooks module is
skipped with no agent-visible error. The same vendor patch also sets
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the spawned process's env whenever a
Paperclip mod directory is present, which opts the process back into loading
installed plugins' hooks modules early. Built-in plugins are unaffected by
this gate either way.

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
   volume (`claude plugin validate <dir>` must pass). This directory is **not**
   tracked in this repo and a deploy does not touch it; it is a host-level
   artifact, so the first install and any later edit to a mod's hook code are
   a direct host-filesystem change, not something `git push` or `deploy`
   ships.
2. Add its path to `PAPERCLIP_CLAUDE_MOD_DIRS`, or to `DEFAULT_MOD_DIRS` in
   `server/src/adapters/claude-mods.ts` when it should be on for every install.
3. If the mod registers a `session.start`, `session.end`, or any other hook
   that calls an engine method the ACP engine's binary may lack (for example
   `$.session.version()`), guard that call (`try`/`catch`, feature-detect) and
   add `.catch(($, e, next) => next(e))` to the hook so one missing method
   never drops the whole record or the whole hook.
4. Prove it with one real run — through the actual ACP engine, not a `claude
   -p` subprocess — and read the mod's own output, not the model's prose. A
   real-looking proof that is actually a `-p` invocation of the SDK binary is
   not evidence for an ACP session: see the section above on why the two
   differ.

Do not point `CLAUDE_CODE_PLUGIN_DIRS` at `/paperclip/mods` itself. Claude Code
treats a folder of plugins as "load every child", which would switch on mods
that were never approved.
