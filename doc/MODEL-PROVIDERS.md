# Claude and OpenAI models on the same agents

Agents that run on a local coding CLI can use either model provider:

- **Claude** through Claude Code (`claude_local`);
- **OpenAI** through Codex (`codex_local`).

Board members pick from one model list with a heading for each provider, on the agent and on each task. Shared code lives in `packages/shared/src/model-providers.ts`.

## On an agent

The agent's **Model** field lists every Claude and OpenAI model, grouped under **Claude** and **OpenAI**. A model under the agent's own heading changes only its model. A model under the other heading moves the agent to that provider when you save:

- **Kept:** environment and secrets, working folder, run limits (`timeoutSec`, `graceSec`), instructions, skills and workspace strategy.
- **Carried across:** the thinking effort, mapped to the closest level the other CLI accepts. Claude `effort` becomes Codex `modelReasoningEffort`, and `xhigh` becomes `high` on the way back.
- **Dropped:** settings only the old CLI understands. On Claude these include Chrome, the Claude account's connectors (`useAccountConnectors`), the chat model and the turn limit. The form says so before you save.
- **AI connection:**
  - On OpenAI, the agent uses the responsible person's connected ChatGPT/OpenAI account: `runtimeConfig.aiConnection = { mode: "responsible_user", method: "subscription", provider: "openai" }`.
  - Moving back to Claude keeps an Anthropic connection if the agent had one. Otherwise the update sends `aiConnection: null`, which removes the binding, and the agent uses the machine's Claude login again.
  - Leaving `aiConnection` out of an update still keeps the existing binding.

A Claude agent's own Claude models come from its server-checked model options, as before. The other lists come from each provider's model catalog.

## On a task

Task overrides (`assigneeAdapterOverrides`) can name the provider as well as the model:

```json
{ "adapterType": "codex_local", "adapterConfig": { "model": "gpt-6-sol", "modelReasoningEffort": "medium" } }
```

- **Who can use it:** only Claude Code and Codex assignees. Other assignees reject a task `adapterType`.
- **What's checked:** the task's `adapterConfig` is checked against the provider the task runs on, so a Codex task can't set `chrome`.
- **When it applies:** at run start. The run uses the assignee with that provider's config and AI connection, and the agent's saved settings don't change.
- **What the run records:** a run-log line names the provider, and `contextSnapshot.executedAdapterType` records it, so run views read the output with the right parser.
- **Sessions:** sessions are stored per provider, so the other provider never tries to resume this one's session.
- **Chats** (in-app and external, such as Telegram) always use the agent's own provider.
- **The task sidebar:** its model picker shows the same headings. Picking a model under the other heading sets `adapterType`; picking one under the assignee's own heading removes it.

## Choosing models per task (agents)

List each provider's models:

- `GET /api/companies/{companyId}/adapters/claude_local/models`
- `GET /api/companies/{companyId}/adapters/codex_local/models`

Don't move work that needs Claude-only features to OpenAI, for example tasks that use the Claude account's Google connectors.
