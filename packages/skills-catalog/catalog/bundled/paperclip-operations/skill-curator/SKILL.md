---
name: skill-curator
description: Curate the company skill library from completed work. Turn repeated procedures and hard-won fixes into skills, catch complex tasks that saved no lesson, keep agent-owned skills (learned, curated, Hermes-imported) accurate, and archive idle ones, using the skills usage report. Never deletes a skill.
key: paperclipai/bundled/paperclip-operations/skill-curator
recommendedForRoles:
  - manager
  - ceo
  - general
tags:
  - paperclip
  - skills
  - curation
  - learning
  - maintenance
---

# Skill Curator

Keep the company skill library useful. Each pass learns from the work the company finished, writes down procedures worth repeating, fixes agent-owned skills that went wrong, and archives skills nobody uses. The library belongs to the company, so every agent benefits whatever model or adapter it runs on.

Agents also learn during their own tasks: before finishing a complex task they save or update a skill, and Paperclip hands each new skill to the agents whose work matches it. The curator is the backstop that catches what they missed and keeps the library tidy.

## When to use

- A scheduled skill-curation routine wakes you.
- The board asks you to review or tidy the skill library.
- A completed task shows a procedure that agents will need again.

## When not to use

- You are working a normal task. Finish it first; curation is a separate pass.
- To change an agent's own instructions (`AGENTS.md`). Use `reflection-coach` for that.

## Rules

1. **Never delete a skill.** The strongest action is archiving, which keeps the skill but stops assigning and recommending it.
2. **Edit only agent-owned skills.** Agents own a skill when its categories include `learned` (written by an agent during a task), `curated` (written by a curator) or `hermes-import` (brought over from Hermes), and it is not `pinned`. Propose changes to every other skill (catalog, hand-written or pinned) in your report instead. A company can enforce this with its skill policy, and Paperclip then refuses with `403 skill_policy_denied`. Never add or remove `pinned`; that is the board's call.
3. **Learn only from evidence.** A new skill needs at least two completed tasks that used the same procedure, or one documented fix that cost real effort to find. Link those tasks in the skill's "Sources" section.
4. **Leave secrets out of skills.** Don't write tokens, keys, passwords, personal data or private URLs into skills. Name the secret or binding instead.
5. **Keep skills small and specific.** One job per skill. Write a description that says when to use it, because recommendations match on the name and description.
6. **Every edit is versioned.** The library keeps each version, so a bad edit can be rolled back, but you still don't overwrite useful content without a reason.

## Procedure

### 1. Read the usage report

```
GET /api/companies/{companyId}/skills/usage?days=30
```

The report gives each skill's `recommendedRuns`, how those runs ended (`recommendedRunsSucceeded`, `recommendedRunsFailed`), `usedRuns` and `lastUsedAt` (runs that actually loaded it), `agentCount`, `agentManaged`, `pinned`, `archived` and a `lifecycle` value, which counts both recommendations and use:

| lifecycle | Meaning |
|---|---|
| `new` | No recommendation yet, but tracking hasn't run long enough to judge it. Leave it alone. |
| `active` | Recommended within the last `staleAfterDays`. |
| `stale` | Not recommended or used for `staleAfterDays`. Check whether it is still relevant. |
| `archive_candidate` | Not recommended or used for `archiveAfterDays`. Archive it if agents own it; otherwise propose archiving. |

Lifecycle is only a hint. A skill that is rarely needed but important (incident response, release steps) stays. Also:

- **Not recommended to anyone:** a skill with `agentCount: 0` can't be recommended, so ask whether the right agents should have it before calling it unused.
- **Fails often:** a skill whose recommended runs fail more often than they succeed needs a closer look.

### 2. Review completed work

Start with the tasks most likely to hold a lesson: complex runs (10 or more tool calls, or 10 or more minutes) that finished without saving or updating any skill.

```
GET /api/companies/{companyId}/skills/learning-candidates?hours=24
```

Each candidate gives the issue, its agent, the tool-call count and the run length. Then list any other issues completed since the last curation pass (default: the last 7 days). For each one, read the description, the final comments and any board feedback. Look for:

- **Repeated procedures:** the same steps done by hand in two or more tasks.
- **Hard-won fixes:** a non-obvious cause, a workaround, or a command or API detail that took several attempts.
- **Corrections:** where the board or a reviewer said "do it this way next time".
- **Skill misses:** a recommended skill that was wrong, out of date or ignored, or a task that clearly needed a skill nobody had.

### 3. Act

- **Prefer updating to creating.** First look for an existing agent-owned skill that covers the class of task, and add the lesson there (a new step, pitfall or support file). Create a new skill only when nothing covers it.

- **New skill:** create it with the `curated` category:

  ```
  POST /api/companies/{companyId}/skills
  {
    "name": "<kebab-case-name>",
    "description": "<when to use it, in one or two sentences>",
    "markdown": "<SKILL.md body>",
    "categories": ["curated"],
    "idempotencyKey": "skill-curator:<name>"
  }
  ```

  Give the body these sections:
  - **When to use**
  - **Steps:** numbered, concrete and checkable
  - **Pitfalls**
  - **Sources:** the task identifiers it was learned from

- **Update a curated skill:**

  ```
  PATCH /api/companies/{companyId}/skills/{skillId}/files
  { "path": "SKILL.md", "content": "<full new SKILL.md>" }
  ```

  Keep what still holds and add the new lesson with its source. Long reference material (API details, command lists, examples) goes in a support file such as `references/<topic>.md`, with one line in `SKILL.md` saying when to read it.

- **Merge near-duplicates (agent-owned only):** fold the unique parts into one skill. Leave the other in place for archiving. Don't delete it.

- **Archive idle agent-owned skills:** preview, then apply:

  ```
  POST /api/companies/{companyId}/skills/lifecycle/apply
  { "dryRun": true }
  ```

  The response lists each skill it would archive (agent-owned, not pinned, `archive_candidate`). Check the list; if a skill is rare but important (incident response, release steps), leave it out by adding the lesson that keeps it relevant or naming it in your report for the board to pin. Then send `{ "dryRun": false }`. Archived skills keep their files and history, are unassigned from agents, and are no longer recommended.

- **Give a skill to agents:** a skill is only recommended to agents that have it. A new skill is given automatically to the agent that wrote it and to up to three agents whose recent tasks match it. For any other agent that needs it, if you are allowed to update the agent, add it without removing anything:

  ```
  POST /api/agents/{agentId}/skills/sync
  { "desiredSkills": ["<skill key>"], "mode": "add" }
  ```

  Otherwise name the agent and skill in your report for the board.

### 4. Report

Post one comment on the curation task, then set it to `done`. Use these sections and say "None" when a section is empty:

1. **Created:** each new skill, with one line on what it captures and its source tasks.
2. **Updated:** each agent-owned skill you changed and what changed.
3. **Proposed changes to other skills:** protected skills, with the change and the reason.
4. **Archived and stale:** each skill you archived, and each stale or protected archive candidate with keep or archive and a reason.
5. **Skills to give to agents:** which agent should get which skill, and whether you did it.
6. **Library health:**
   - the number of skills in each lifecycle
   - skills that fail often
   - the tracking start date

## Pitfalls

- **Judging too early:** tracking only counts recommendations made since it started. Read `trackingStartedAt` before calling anything unused.
- **One-off skills:** a procedure seen once is rarely worth a skill. Wait for the second time unless the fix was hard to find.
- **Over-broad descriptions:** a description that matches everything gets recommended everywhere and helps no one.
- **Capturing the wrong things:** don't write a skill about a one-off task outcome, a temporary outage, credentials, or "I couldn't do X" (unless the lesson is the fix). Write procedures that will hold next time.
