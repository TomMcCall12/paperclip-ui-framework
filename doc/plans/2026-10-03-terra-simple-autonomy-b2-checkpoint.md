# Tom’s Lab — B2 security reconciliation (not live)

**3 October 2026, afternoon session.** This continues step 1 of [[(C) Simple Autonomy Status — 2026-10-03]] and follows [[(C) Simple Autonomy B1 Candidate Checkpoint]]. Telegram remains out of scope. **Nothing was deployed, pushed, migrated or restarted.** The live Lab is still on `e6f2e353…` and was not touched.

## Candidate state
- Worktree `/media/External SSD/paperclip/isolated-candidates/terra-simple-autonomy`, branch `feat/terra-simple-autonomy`, now **clean at `c40575535787e17942452f61fdc09c64a3886d48`** (seven new local commits on top of `575d57d`).
- The eight-file uncommitted approvals draft was inspected, tested and committed — it is no longer a loose draft.

## New commits (oldest first)
1. `4e5c2b2` — **Hire approvals + token alias.** Hire payloads are checked at approval create/resubmit before normalisation or persistence. Approve now checks the payload, moves the status and activates/creates the agent in **one transaction under the approval row lock**, so a rejected payload or failed activation leaves the approval open and no agent changed (closes the approved-but-inactive hazard). `activatePendingApproval` locks the agent row and re-checks the Hermes key binding. Revision/resubmit are conditional on status. Reject only terminates this company’s pending agent. A stored secret ref under the Hermes `token` alias (never resolved at runtime, since only `apiKey` is a schema secret) is now rejected on saved-agent PATCH, test-environment and approvals.
2. `c2da30b` — **Flat-provider fix integrated** (cherry-pick of the inspected `379e2c6`): a flat model list without a named current provider is rejected; grouped responses (what the live gateway sends) are unaffected.
3. `35ebe0b` — **Override guard on every issue writer.** `issueService.create/update` check the resulting assignee/override pair whenever either changes, which covers **plugin `issues.create`/`issues.update`**, reassignment and child creation. **Checkout** checks overrides already on an unassigned issue against the agent taking it. **Company import** drops a rejected override set with a warning instead of failing the import.
4. `091ab5b` — **Dispatch-time task-model check.** Before the adapter runs, the heartbeat asks the agent’s *own* gateway for its current provider’s models and fails the run (`configuration_incomplete` / `issue_task_model_unsupported`) when a saved task model is not listed or the list cannot be verified. Covers legacy rows saved before the write check.
5. `9a97c9d` — Fixed the inherited UI type error in `NewIssueDialog.test.tsx:714`. **UI typecheck now passes.**
6. `f735788` — Review fixes: the orphan-blocker recovery sweep skips (instead of crashing on) a blocker whose overrides its creator cannot run; a flat list with zero models for the current provider is `invalid_response`, not an empty “available” list.
7. `c405755` — **Hire approvals bound to their own agent.** Review found a generic approval could name *any* pending agent in the company and, once approved, overwrite and activate it. A generic `POST /approvals` hire may no longer name an agent (only the agent-hire flow creates agent-bound approvals), and a resubmit must keep its original agent.

## Checks actually run (this environment)
- **Full `pnpm -r typecheck` and full `pnpm build`: both passed (exit 0)** at `9a97c9d`, including the Rust runner on **rustc 1.97.1 = the source-pinned toolchain**. This supersedes the old-container Rust failure. Later commits touched only server/adapter code and passed `tsc --noEmit` for server and the Hermes adapter.
- Final focused sweep at `c405755`: **877 passed / 1 skipped across 20 server suites** (approvals, hire, agent create/default-model/test-environment, issues service, company portability ×3, heartbeat override guard, recovery, checkout, plugin host, Hermes routes). Hermes adapter: 94/95. The one failure (`command-resolution.test.ts`, local CLI binary lookup) is in a file this branch never changed.
- `issue-update-comment-wakeup-routes` and `paperclip-issue-update-helper` fail **identically on the pre-change tree** (8 tests), so they predate this work and are recorded here as unrelated.
- One AI code review (high effort) ran over `575d57d..HEAD`. Findings that were fixed are listed above.

## Accepted trade-offs (not fixed, deliberate)
- **A short gateway outage at dispatch fails a Hermes run that has a task model** as a configuration problem, rather than retrying it. Fail-closed was chosen on purpose. Watch for this during real team runs.
- Each such dispatch makes one extra model-list request to the agent’s own gateway. There is no cache yet.
- A Hermes agent whose saved config already holds a `token` secret ref must move it to `apiKey` before any further save. No live agent is known to be affected: Jarvis uses `apiKey`.
- An open approval naming an agent that is no longer pending now returns 422 on approve. The board should reject it and resubmit.
- Approve-time agent creation runs secret normalisation inside the approval transaction. A rollback after an external secret write could leave an orphaned managed secret.

## What this does NOT prove
- This is **not an independent human or separate-agent review** of the exact commit `c405755`. Get one before release.
- Still not done: the disposable-PostgreSQL smoke test of the built image; real-team acceptance (step 4: model selection through served runs, worktrees, blocked handoff with no wake loop, interruption and recovery); a rollback-safe release (step 5). The live board is unchanged.
- The Obsidian vault was mounted **read-only** in this session, so this note could not be written into the vault directly; it was delivered as a file.
