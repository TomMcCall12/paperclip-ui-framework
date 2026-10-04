# Tom’s Lab — B2 security reconciliation (not live)

**3 October 2026, afternoon session.** This continues step 1 of [[(C) Simple Autonomy Status — 2026-10-03]] and follows [[(C) Simple Autonomy B1 Candidate Checkpoint]]. Telegram remains out of scope. **Nothing was deployed, pushed, migrated or restarted.** The live Lab is still on `e6f2e353…` and was not touched.

## Candidate state
- Worktree `/media/External SSD/paperclip/isolated-candidates/terra-simple-autonomy`, branch `feat/terra-simple-autonomy`, now **clean at the tip of `feat/terra-simple-autonomy`**: code last changed in `510dfaa` ("address final review of the review-fix commits"), on top of `575d57d`.
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

## Update — 3 October, evening: disposable smoke of the built candidate

**Environment fact:** this session runs in a *disposable* container made from the live image. PID 1 is the Claude remote-control session, and `/paperclip` is a private tmpfs. Live data is **not** mounted, so no live backup was available to restore. The smoke used a fresh embedded PostgreSQL in a throwaway home on a separate port (`127.0.0.1:3199`). The live board at `192.168.0.163:3100` was read only for health, and it stayed on `e6f2e353…` and `ok` throughout.

- **Built and booted the exact candidate**, launched the same way the production image is (`node --import tsx/dist/loader.mjs server/dist/index.js`). From a first run, all migrations applied automatically and health was `ok` in **authenticated/private** mode, reporting the candidate commit. It then restarted in `local_trusted` mode for an HTTP-driven smoke, and later restarted on the **existing** database at `de43372` without issue.
- **Over real HTTP, against a fake loopback Hermes gateway** (grouped provider list, as the live gateway returns):
  - Hermes agent creation stored its plain key as a managed secret. Model options listed only the current provider's models; an OpenRouter model was excluded.
  - Issue writes: a listed task model returned 201. An other-provider model returned 422 `issue_task_model_unsupported`. A key-redirecting override returned 422 `issue_assignee_override_not_allowed`. Reassigning an unsafe unassigned issue to the Hermes agent returned 422.
  - Agent PATCH: the agent's own key moved to `token` returned 422. A model-only PATCH returned 200.
  - Approvals: a generic approval naming an agent returned 422 `hire_approval_agent_mismatch`. A generic Hermes approval without an agent returned 422, pointing to the hire flow. A generic non-Hermes approval returned 201.
  - Hire lifecycle: with board approval required, the agent-hire flow produced a pending agent plus an approval bound to it. Approve moved the agent to `idle`, with its key stored as its own secret and working. Re-approve was a no-op.
  - **Dispatch-time check in real heartbeats:** after the gateway stopped offering the task model, both the assignment wake and the manual wake failed `configuration_incomplete` **before any run request**; the gateway saw only model-list calls. The issue moved to `blocked` with **no wake loop** (2 runs, then quiet). An unverifiable list (zero current-provider models) also blocked. After the model was restored and the issue unblocked, the check passed and a real `POST /v1/runs` reached the agent's own gateway with the right key. That run returned 404 only because the fake gateway does not implement runs.
- **Bug found by the smoke and fixed (`de43372`):** the blocked-issue comment wrongly said "required secret/env bindings are missing". It now explains that the task model is unavailable or unverifiable. Unit test added, 22/22 pass, and the smoke confirmed the new wording.

## Review status
- An automated multi-angle review of `575d57d..c405755` was launched but **failed on a usage limit** (resets 19:40 UTC). No result was produced.
- I self-reviewed the commits the first review never saw (`f735788`, `c405755`, `de43372`). This is **not independent**. It found no defect in the approval binding: the resubmit race is covered by the conditional update. Issue approval linking does not create payloads, and the built-in and plugin-managed hire approvals bind to the agent they just created.
- **Residual found and closed:** plugin-managed agents (`plugin-managed-agents.ts`) are created and reset through the service, so the route guards never ran on plugin-declared Hermes configs. Create now refuses a stored-secret key, and reset may keep only the agent's own key at its own gateway, never under `token`. Two new tests were added; the suite passes 15/15.

## Independent review of `575d57d..782562d` (3 October, evening)
Eight separate reviewer agents ran over the range, each covering one angle: line-by-line, removed behaviour, cross-file tracing, language pitfalls, wrappers and transactions, design altitude, reuse, efficiency. The transaction and lock design of approve, and the savepoint use, were cleared. Confirmed findings, all fixed in three commits:

- `6d19073` — **Company import / teams-catalog install bypassed every Hermes key rule.** A same-company CEO agent could import a Hermes agent that pointed an existing stored secret at its own URL. Import now applies the rule before normalisation. The rule is now one helper, `hermesAgentKeyViolation`, used by every agent writer: routes, hire approvals, plugin-managed agents and import. Previously it was hand-copied in three places, already drifting. `token` is now a schema secret field, stored managed and resolved at runtime, instead of being rejected at each writer; that rejection had locked legacy agents out of UI edits.
- `f7f4a6e` — **Issue guards narrowed to real changes.**
  - Checkout checks only unassigned issues. A checkout of another agent's issue is a 409 again. An override 422 inside heartbeat auto-checkout now blocks the issue as `configuration_incomplete` with its notice, instead of a generic `setup_failed`.
  - `update()` checks only a real change. Before, it broke confirmation accept and reject on legacy rows.
  - The agent lookup is company-scoped.
  - The orphan-blocker sweep assigns and defers to the dispatch check, which blocks with a visible notice. Before, it was silently skipped on every sweep.
  - Recovery next-action text names the real cause.
  - Task models are trimmed before comparison.
  - Unexpected verification errors are logged.
- `b9648d1` — **Approval hardening.**
  - Runner tools `list_approvals`/`get_approval`/`get_approval_context` now redact payloads. A typed gateway key in a hire approval was readable by any runner agent.
  - A non-UUID legacy `agentId` returns 422, not a Postgres 500.
  - Reject also terminates a hire paused while pending.
  - Activation restores redaction placeholders from the pending agent's own saved values. Before, the placeholder was either refused, leaving the approval stuck open, or written into the live config; the test proves this against the pre-fix code.

Checks: server `tsc` clean. **1237 passed / 1 skipped across 31 suites**, covering every changed area plus teams-catalog, hire, issue-thread interactions and secret bindings. Each new regression test targets one finding. One `heartbeat-process-recovery` test ("does not reap active adapter executions…") failed once under the full parallel load and passed twice alone. It is timing-sensitive and unrelated.

**Recorded, not changed:**
- The dispatch model-list call is uncached: one extra request per run, which is lighter than any redesign.
- Concurrent writes can race the write-time guard; the dispatch check is the backstop.
- Activation applies the payload's `reportsTo`/`defaultEnvironmentId` without manager or environment checks. This predates the branch.
- Switching an agent onto Hermes does not re-check its issues; the dispatch check catches it.
- Some duplicated helpers remain: the model-options parse branches, and the payload adapter-type derivation.

## Second independent review: the review-fix commits `86e2e34..b9648d1`
This review found a hole in the redaction-restore fix and four smaller issues, all fixed in `510dfaa`:

- **Critical, fixed:** activation could fill a redaction placeholder from the saved config into a payload whose adapter or destination had changed. A resubmit could then carry a saved key somewhere the board never saw. Now a field is restored only when the filled-in payload exactly equals the saved field (key order ignored). Any leftover placeholder fails activation with a 422. Only env bindings refuse placeholders at persistence; other fields such as headers would otherwise have been written as-is, and the tests prove this.
- Reject again terminates only a `pending_approval` hire, so a live paused agent is never terminated. Instead, a pending hire can no longer be paused: a manual pause returns 409, and a budget or system pause is a no-op.
- The Hermes key rule trims adapter types, so a padded `" hermes_gateway"` in an import is still checked.
- Company import runs a **preflight** over every agent before any row is written, so a refused key no longer leaves a partial import.
- One shared `redactApprovalPayload` now serves both the HTTP routes and the runner tools.
- **Deliberately not changed:** config-revision rollback. A revision only replays a key-and-gateway pairing this same agent already held, so it exposes nothing new. An earlier reviewer cleared this path too.
- Recorded only: a checkout race whose backstop is the dispatch check, and some remaining wrapper/restore helper duplication.

**Final checks at `510dfaa`:**
- 1247 passed / 1 skipped across 32 suites.
- **Full `pnpm -r typecheck` and `pnpm build` both exit 0, stamped `510dfaa`.**
- Rebuilt-artifact smoke: a Hermes agent configured with `token` stores it as a managed secret, leaves no plaintext, and authenticates to its gateway.

## Release to the live Lab — 4 October 2026, ~07:30 UTC
Host access (SSH as `hermes-operator`, with Docker and sudo) was granted on 4 October, so the remaining gates ran on the ZimaBoard:

1. **Exact image built from source.** `git archive 510dfaa` was built as the production target, stamping commit `510dfaa`: `paperclip:tom40-terra-510dfaace1af65d925c211961b8558f013956621`. The same Rust 1.97.1 runtime layer live uses was then added (`Dockerfile.managed-capacity.tom40-terra`), giving `paperclip:tom40-terra-rust-1.97.1`. Inside the image: rustc/cargo 1.97.1 and `build-info.json` commit `510dfaa`.
2. **Restored-database smoke.** The 06:33 hourly live dump was restored into a throwaway `postgres:16` on an **internal-only Docker network**, with no egress, so no Telegram, Hermes or webhook calls were possible. It holds 1 company, 9 agents, 62 issues and 176 runs. The candidate image ran against it with the scheduler off:
   - health `ok` at `510dfaa`
   - migrations "already applied": no schema change between live and the candidate
   - 0 error-level logs; startup recovery `ready`
   - Jarvis's real config (`apiKey` stored secret, `http://192.168.0.163:8642`, insecure-HTTP opt-in) passes the new key rule, and a model-only PATCH returns 200
   - the only real issue with Hermes overrides is TOM-28 (`done`)

   The smoke containers and network were removed afterwards.
3. **Release.** Live had no running, queued or retrying runs; the last run was the 04:00 nightly.
   - Compose backed up to `docker-compose.yml.pre-tom40-terra-20261004T072739Z.bak`.
   - Live stopped, and a full data copy taken: `data.pre-tom40-terra-510dfaa-20261004T072739Z`.
   - Compose image set to `paperclip:tom40-terra-rust-1.97.1`, then `up -d`.
4. **Readback.**
   - Health `ok`, commit `510dfaa`, authenticated/private, bootstrap `ready`, database backup `ok`.
   - UI returns 200; an unauthenticated `/api/companies` returns 403.
   - 0 error-level logs; migrations already applied; restart count 0.
   - Hermes gateway health 200.

**Rollback:** `cd "/media/External SSD/paperclip" && sudo cp docker-compose.yml.pre-tom40-terra-20261004T072739Z.bak docker-compose.yml && sudo docker compose up -d paperclip`. The previous image `paperclip:tom39-rust-1.97.1-fast-tmpfs` (`982597be1180`) is still present. No migration ran, so the database needs no rollback. A full pre-release data copy also exists.

## Post-release acceptance on live — 4 October 2026, 07:52–07:57 UTC
Board session approved by Tom through a CLI-auth challenge, scoped to the Tom's Lab company. The token was **revoked afterwards** (now returns 401).

- **Jarvis model options (new in this release)** against the real gateway: `available`, provider `openai-codex`, `gpt-6.1-sol` listed, and only that provider's 15 models shown.
- **TOM-63** (`2145d7f7-96f5-4a04-b374-8c7d3bfd97e8`) was created for Jarvis with task model `gpt-6.1-sol`. The **write-time task-model check passed against the real gateway.**
- Jarvis run `2d80d085-e5fb-425d-9daa-4409db4ae375` (assignment, gateway run `run_ef8df13359d946618d9405c40d98ac52`) **succeeded, exit 0**. The **dispatch-time model check passed before it was sent.** Jarvis created **exactly one** child, TOM-64 (`dab0d8c7-ab8e-41ac-8d03-21b02a1d3905`), for the Software Engineer.
- Engineer run `29233236-2b1c-4…` (assignment) **succeeded**. Its worker-authored comment reads exactly `LAB_RELEASE_OK-10040752`, and TOM-64 is done.
- Jarvis then posted a verifying comment on TOM-63 citing the child, the comment id and the Engineer run, and marked TOM-63 **done**. No other issues were created, and there was no wake loop.

Scope: this proves the single-chain delegation and both model checks on the released build. It is **not** the full real-team acceptance; parallel worktrees, blocked handoff and interruption/recovery remain open.

## Still open
1. Done: post-release end-to-end chain TOM-63/TOM-64 (see above).
2. **Real-team acceptance (step 4):** model selection through served runs, parallel worktrees, blocked handoff with no wake loop, and interruption/recovery truth. This is now possible on live.
3. Optional: an independent review of `b9648d1..510dfaa`.
