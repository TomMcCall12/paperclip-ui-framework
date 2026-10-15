# Skill learning

Agents learn the way Hermes agents do. They save what a task taught them as company skills, Paperclip gives each new skill to the agents who need it, and a curator keeps the library tidy. It works the same on every model and adapter: Claude Code, Codex, Hermes gateway agents and any future provider. Agents use the ordinary company skills API.

## The loop

1. **Recommend.** Before each run, Paperclip picks the skills that best match the task and names them in the wake prompt (`relevant-skills.ts`). As in Hermes's skill index, the prompt tells the agent to load a matching skill even when it could do the task without it. Archived skills are never recommended.
2. **Track.** While the run streams, Paperclip counts tool calls and notes which skills the agent loaded. It reads Claude `tool_use` blocks, ACP engine `acpx.tool_call` events, Codex tool items and Hermes gateway `tool.started` events (`createRunToolTracker`). Reading a skill's `SKILL.md` counts as loading it, as Hermes counts `skill_view`, because most agents load skills that way. The run log gets "Run made N tool call(s)", and the task thread shows "used the skill X".
3. **Learn in the task.** Every task's wake prompt ends with a "Learning" step adapted from Hermes's background review:
   - **When to save:** a board correction, a hard-won fix, or a skill that was wrong.
   - **Where to save it, in order:** update a skill the agent used; update a broader skill; add a support file; or create a new skill for the class of task.
   - **What not to save:** one-off outcomes, temporary outages, and secrets.
   - The agent saves lasting board preferences to its own memory, and ends its comment with `Learning: …`.
   - In chats, `/learn` runs the same review on demand.
   - **Find a way first:** before marking any part of a task failed, the prompt asks the agent to try at least two other routes, such as another official source or API, another tool, a better-equipped agent, or smaller steps. A CAPTCHA is never defeated: the agent gets the information elsewhere or asks the board for that one step. A route that worked is saved in the Learning step, so the next run goes straight to it.
4. **Hand out.** A skill an agent creates is tagged `learned`. Paperclip gives it to its creator and to up to three agents whose recent tasks share at least three distinctive words with it (`distributeNewSkill`). The thread shows "created the skill X".
5. **Backstop.** `GET /api/companies/{companyId}/skills/learning-candidates?hours=24` lists complex finished runs that saved or updated no skill: 10 or more tool calls, or 10 or more minutes, in a non-chat task. A daily routine reviews them with the `skill-curator` skill.
6. **Curate.**
   - The usage report (`GET …/skills/usage`) gives each skill's recommendations, real use and lifecycle (`new`, `active`, `stale`, `archive_candidate`).
   - `POST …/skills/lifecycle/apply` archives idle agent-owned skills: it adds the `archived` category and unassigns them from agents. Archived skills keep their files and history.
   - Send `{"dryRun": true}` first to preview. Never delete a skill.

## Who owns a skill

Categories record who owns a skill:

| Category | Meaning |
|---|---|
| `learned` | Written by an agent during a task. |
| `curated` | Written by a curator. |
| `hermes-import` | Brought over from Hermes. |
| `pinned` | The board wants it kept as is. Never archived. |
| `archived` | Retired by the curator. Not assigned and not recommended. |

A skill is **agent-owned** when it has `learned`, `curated` or `hermes-import` and is not `pinned`. Agents are told to change only agent-owned skills, and the curator archives only agent-owned skills.

## Protecting the rest

Under the V1 open default (SPEC 9.10), agents may change any company skill. A company that wants Hermes-style protection sets an explicit skill policy that uses the `categories` selector. This policy leaves agents free to create skills and to edit agent-owned ones. It refuses agent changes to pinned skills and to every other skill (catalog and hand-written) with `403 skill_policy_denied`. The board is not bound by agent rules.

```json
{
  "schemaVersion": 1,
  "defaultEffect": "allow",
  "rules": [
    { "id": "protect-pinned", "priority": 10, "effect": "deny", "subject": { "type": "all_agents" },
      "actions": ["skills.edit", "skills.update", "skills.reset", "skills.remove"], "resources": { "categories": ["pinned"] } },
    { "id": "allow-agent-owned", "priority": 20, "effect": "allow", "subject": { "type": "all_agents" },
      "actions": ["skills.edit", "skills.update", "skills.reset", "skills.remove"], "resources": { "categories": ["learned", "curated", "hermes-import"] } },
    { "id": "protect-others", "priority": 30, "effect": "deny", "subject": { "type": "all_agents" },
      "actions": ["skills.edit", "skills.update", "skills.reset", "skills.remove"] }
  ]
}
```

Set it with `PUT /api/companies/{companyId}/skill-policy`, passing `expectedRevision`. Board administrators only.

## Chat model

A manager can also choose the model per task. Set `assigneeAdapterOverrides.adapterConfig` when creating or reassigning the task. For Claude, Codex and OpenCode agents, only the model, effort, run budget and workspace strategy can be overridden this way. Hermes gateway agents accept the model only. A task never changes an agent's tools, permissions, arguments, folder or environment.

An agent can use a cheaper model for chats than for tasks. Set `chatModel` and `chatEffort` in its adapter config, or use "Chat model" and "Chat effort" on a Claude agent's settings page. They apply to Agent Chat and to external chats such as Telegram. A per-task model override still wins.
