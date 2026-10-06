# Tom's Lab — real-team acceptance and TOM-62 repairs (4 Oct 2026)

Released build: Paperclip `510dfaa` (image `paperclip:tom40-terra-rust-1.97.1`). Context: [[(C) Simple Autonomy B2 Security Reconciliation — 2026-10-03]], [[(C) Simple Autonomy Status — 2026-10-03]].

## Real-team acceptance on live (08:01–08:19 UTC, board session approved by Tom, token revoked after)
| Test | Issue(s) | Result |
|---|---|---|
| Delegation chain + Jarvis task model (earlier) | TOM-63 → TOM-64 | **Pass.** Write-time and dispatch-time model checks passed against the real gateway. Jarvis created exactly one child, and the Engineer posted the exact nonce. |
| 1. Per-task model override (Engineer) | TOM-65 | **Pass.** The override was `claude-haiku-4-5`; run `05ebd3cf` `modelUsage` shows only `claude-haiku-4-5`, not the default Sonnet. |
| 2. Parallel isolated worktrees | TOM-67 (Engineer), TOM-68 (Strategic Advisor) | **Pass.** Both ran at the same time, each in its own `git_worktree` on its own branch, with one commit each (`22750d1`, `908a5a2`). `main` of the throwaway sandbox repo was untouched. Uses project "Lab acceptance sandbox" and repo `/paperclip/workspaces/lab-acceptance-repo`. The isolated-workspace experimental flag was enabled only for the test and is **back to off**. |
| 3. Blocked handoff, no wake loop | TOM-69 | **Pass.** The Engineer blocked and @-mentioned Jarvis, and Jarvis was auto-woken and acknowledged. The issue stayed `blocked` for 8 minutes, with exactly 2 runs and 2 comments and no re-wake. The Stage A loop defect did not recur. |
| 4. Interruption truth | TOM-66 | **Pass.** The board cancelled the run mid-`sleep`. The run became `cancelled`, there was no fake completion comment, and recovery stood down by design (operator cancel). There was no re-dispatch loop. The test issue was then closed as cancelled. |

**Found, not changed:**
- **Codex Direct Standby has no Codex credentials.** There is no ChatGPT sign-in and no `OPENAI_API_KEY`, so it fails closed with `codex_credentials_missing`. Either sign it in or leave it as standby.
- **Jarvis made two Paperclip readbacks with no credential** (`Python-urllib`, no `Authorization`) during the TOM-69 mention wake, and got 404s. Hermes already has `PAPERCLIP_API_URL` and `PAPERCLIP_BRIDGE_API_KEY`; Jarvis's ad-hoc scripts just don't send the key. The handoff still worked, because Jarvis works from wake context. This is a Hermes/Jarvis skill fix.

## TOM-62 finding 1 — Hermes updater recreated an unchanged image (fixed)
`/DATA/AppData/hermes-config/update-hermes.sh` compared the container's full `sha256:` image ID with `docker images -q` (a 12-character short ID), so they never matched and every weekly run recreated Hermes. It now uses `docker image inspect --format '{{.Id}}'`. This was proven on the host: the old comparison is unequal and the new one is equal for the same image.

Readiness also now waits for the dashboard (`:9119/login`, the watchdog's probe) **and** the gateway (`:8642/health`). The gateway comes up about 3 minutes after the dashboard. The manifest records both, and reports `ok:false, stage: readiness` if either times out. Backup: `update-hermes.sh.bak-20261004T080028Z`. First real exercise: the next Sunday 04:30 cron run.

## TOM-62 finding 2 — Hermes search index corruption (fixed)
In `/DATA/.media/External SSD/hermes-config-data/state.db` (1.7 GB):
- `messages_fts` passed its FTS5 integrity check.
- `messages_fts_trigram` failed it: *database disk image is malformed*.

The repair ran 08:20:53–08:27:31 UTC:
1. The watchdog cron line was paused.
2. Hermes was stopped gracefully.
3. The WAL was checkpointed, and a full backup taken: `state.db.pre-fts-repair-20261004T082053Z`.
4. The FTS5 `rebuild` ran inside a one-off container from Hermes's own image. The host Python's SQLite has no FTS5 support, and a first attempt aborted harmlessly on that.
5. The index was rebuilt in 199 s from 116,346 rows. The recheck passed, and `pragma quick_check` returned ok.
6. Hermes was restarted and the watchdog restored.

Afterwards there were 0 malformed or corrupt log lines, the dashboard returned 200, the gateway returned 200 at 08:30:32, and Jarvis's model list loaded through it.

A redundant second pre-repair copy, `state.db.pre-fts-repair-20261004T081934Z`, is a cheap reflink. Delete it whenever convenient.

## Other TOM-62 items (not in scope today)
- Nightly vault job `3568738e340a` is still pinned to DeepSeek/OpenRouter and failing with 401.
- The legacy Hermes post-update review job `53f1f5a66747` duplicates Paperclip's review and is allowed to make changes.
- The family-payment safeguard's Google OAuth has expired.

## Follow-up fixes — 4 Oct 2026, 08:35–08:45 UTC
- **Jarvis anonymous readbacks — fixed.**
  - Root cause, from the TOM-69 session transcript in Hermes `state.db`: Jarvis's scripts read only `PAPERCLIP_API_KEY`, which gateway wakes never inject, so they silently sent no header and got 404s.
  - The bridge key is **valid** (`/api/agents/me` returns 200 as Jarvis) and can read issues, comments and runs. The "401" in the old migration document is out of date.
  - Fix: skill `paperclip-agent-operations` step 2 now says to use `PAPERCLIP_API_KEY`, falling back to `PAPERCLIP_BRIDGE_API_KEY`, gives the exact snippet, and warns that a 404 from this instance can mean "not authenticated". Backup: `SKILL.md.bak-20261004T084326Z`.
  - Proof: Jarvis's original readback rerun in the Hermes container returned run `succeeded` and TOM-69 `blocked`, with the key sent.
  - Also tested and ruled out: Hermes secret-stripping. The key already reaches terminal children, and the trial skill-frontmatter change was reverted to the original byte-for-byte.
- **Duplicate Hermes cron jobs — paused** (reversible with `hermes cron resume <id>`; backup `cron/jobs.json.pre-dedupe-20261004T083859Z`):
  - `3568738e340a` Nightly vault update. This was the DeepSeek/OpenRouter job failing with 401.
  - `53f1f5a66747` Hermes post-update review. It was mutation-capable and duplicated Paperclip's review.
  - `ea5b8fb54c2f` Sunday weekly check-in.
  - `42a68fc7dfac` Weekly host crontab audit.

  All four are Paperclip routines owned by Jarvis, as the Hermes→Paperclip migration intended. Hermes now runs only host and no-agent scripts: Expo shutdown, Drive sync, parent payments, Claude continuity. Paperclip's two nightly vault routines are *not* duplicates (one is a read-only review, the other the writing update), so both stay.
- **Redundant Hermes backup deleted:** `state.db.pre-fts-repair-20261004T081934Z`. The real pre-repair backup `…082053Z` is kept.
- **Family-payment safeguard — still needs Tom.** The Google Workspace token (`google_token.json`, issued 25 Sep) returns `invalid_grant: Token has been expired or revoked` on a one-cell read. Re-authorising needs Tom's Google consent.
- **Codex Direct Standby provider switch — needs a board session** (not available while Tom is away).

## Board items done via Tailscale approval (~08:50 UTC)
- Codex Direct Standby: codex_local (no credentials) -> claude_local / claude-sonnet-4-6, verified with TOM-70 (nonce LAB_STANDBY_OK-0851, status error -> idle). Restore Codex later via the agent's config revision rollback.
- TOM-69 closed as cancelled. Board session revoked (401).

## Make default model option released (~09:41 UTC)
- 570b907 (UI only), image paperclip:tom41-rust-1.97.1; health ok, 0 errors. Rollback: docker-compose.yml.pre-tom41-20261004T094043Z.bak (returns to 510dfaa).

## Skills, gateway credentials, curator and notes vault (11:15–16:20 UTC)
- **Make default improvements:** `df9f575`, image `tom42`.
- **Relevant skills for every adapter (Option 2):** `fcd15fb`, image `tom43`. Proven by TOM-75 (Claude) and TOM-76 (Hermes).
- **Per-run gateway credentials:** `86dc716`, image `tom44`. Proven by TOM-78: UXDesigner acted as itself, not Jarvis.
- **Skill curator:** `2616b30`, image `tom45`.
  - Adds the usage report `GET /companies/:id/skills/usage`, the bundled `skill-curator` skill and a built-in Skill Curator definition (built-in agents are experimental and off on this Lab).
  - On this Lab, the Weekly skill curation routine runs on the Strategic Advisor, Sundays 07:00 Europe/London.
  - First run TOM-79 created 3 curated skills.
- **Notes vault:** `98cc04a`, image `tom46`. See `doc/NOTES-VAULT.md`.
  - The vault is mounted only in `paperclip-notes-vault-bridge`, and Jarvis is the only writer.
  - Proven by TOM-80: Jarvis created and appended a vault note through the API, and the changelog rows were added automatically.
  - **Rollback:** `docker-compose.yml.pre-tom46-20261004T161001Z.bak` plus `.env.pre-tom46-20261004T161001Z.bak`.

## Tom's decisions, outage and tom47 (4–5 Oct)
- **Plated block removed.**
  - The legacy `requiresApproval` flag came from Hermes's setup board key. Both "Hermes Paperclip setup" board keys are revoked.
  - New writes of the retired flags are refused with 422 (`126e592`).
- **Ship rule.** Jarvis always pushes and deploys once all tests pass.
- **Jarvis moved to Claude Code** (`claude-opus-5-5`, medium effort). Host routines moved to Hermes Runtime.
- **Outage.** During an image build, a Docker daemon that had run for 17 days grew to about 10 GB and filled RAM and swap. Recovered by restarting Docker. Builds now run through a memory-guarded script.
- **Live since 5 Oct, 12:30 UTC:** `8fca1cd` (image `tom47`).
  - The notes vault bridge runs as root with only DAC_OVERRIDE, CHOWN and FOWNER, and gives new files the vault owner.
  - **Rollback:** `docker-compose.yml.pre-tom47-20261005T123022Z.bak`.
- **Open, waiting on Tom:**
  - GitHub connection grant/secret mismatch: a personal grant points at a company secret.
  - Hermes Runtime gateway URL and key.
  - Codex Direct Standby device sign-in.

## 5 Oct: GitHub for git, chat improvements (live `52dafbc`, image `tom49`)
- **Codex Direct Standby** is signed in with ChatGPT through Paperclip's device-code login (TOM-87).
- **GitHub:**
  - The connection was reconnected as a personal account. Paperclip's tool calls work (TOM-89).
  - `d2e0142` lets personal-access-token connections serve git, so the Plated workspace now clones. Git credentials fall back to the run row's responsible user.
- **Chat improvements (`52dafbc`):**
  - Board-writing guidance in every wake prompt.
  - Folded "Technical details" sections.
  - Plain-English tool labels in the live status line.
  - Skill recommendation, create and update lines in task threads.
- **TOM-77** is handed to the Software Engineer as a child task. Jarvis owns the review, tests, deploy and push.
- **Open:**
  - The Hermes Runtime key doesn't match Hermes's live gateway key.
  - Four unpushed Plated commits need Tom's decision.
  - Tom needs to send an example of a reply that didn't reopen a task.

## 5–6 Oct overnight: Hermes-level skill learning (live `4af9d3a`, image `tom53`)
Tom asked for skills to work "at the Hermes level": agents learn during tasks, new skills reach the agents who need them, and the curator maintains imported Hermes skills. See `doc/SKILL-LEARNING.md`.
- **Learning in the task** (`e8ba912`, `ed87a20`):
  - Every task's wake prompt ends with a "Learning" step adapted from Hermes's background review. The final comment ends with `Learning: …`.
  - Lasting board preferences go to the agent's memory.
  - In chats, `/learn` runs the review on demand.
- **Tracking** (`e8ba912`, `e9fbf22`, `430538d`):
  - Each run's tool calls and loaded skills are counted for Claude, Codex and Hermes gateway agents.
  - Threads show "used the skill X", and the usage report counts real use.
- **Hand-out:** a new agent-written skill is tagged `learned` and given to its creator and to up to three agents whose recent tasks match it.
- **Backstop and curation:**
  - `skills/learning-candidates` lists busy runs that saved nothing.
  - `skills/lifecycle/apply` archives idle agent-owned skills.
  - Routines: the "Daily skill learning sweep" (new, 06:30 London) and the "Weekly skill curation" (updated). Both run on the Strategic Advisor.
- **Ownership:**
  - The 29 refreshed Hermes skills that lacked `hermes-import` now have it, so all 89 imports are agent-owned.
  - Protection uses the company skill policy, with a new `categories` selector (`ad99b40`, SPEC 9.10 updated). An earlier built-in guard broke the V1 open default, so it was removed.
- **Chats:** Jarvis's chats (in Paperclip and on Telegram) use `claude-sonnet-5` at medium effort; tasks stay on Opus 5.5. The settings page shows "Chat model" and "Chat effort".
- **Fixes found while testing:**
  - A resumed Claude session that is too long now restarts fresh (`a9cbf13`; this is what stranded TOM-92).
  - Reassignment now also cancels the previous assignee's queued run (`3640287`). On TOM-102 that run took the task back.
  - Editing SKILL.md kept wiping `hermes-import` (live on Jarvis's and Hermes Runtime's edits). Ownership categories now survive file edits (`4af9d3a`). The affected skills were re-tagged.
- **Live checks:**
  - **Jarvis on TOM-102:** reviewed the week's failed runs, added a support file to an existing skill, and ended with `Learning: …`.
  - **Hermes Runtime on TOM-90:** 22 tool calls and its `skill_view` loads were tracked, it updated a skill, and its run credential worked.
  - **Chat:** Jarvis's chat turn ran on `claude-sonnet-5`.
  - **Skill policy:** a simulation allows agents to edit agent-owned skills, refuses edits to catalog and pinned ones, and allows creating new skills.
- **Rollback:** `docker-compose.yml.pre-tom53-*.bak`, or `pre-tom52`/`pre-tom50`. To drop protection, `DELETE /api/companies/{id}/skill-policy`.
- **Open for Tom:**
  - The Software Engineer is capped at 16 turns and 7 minutes per run. It hit the cap five times on TOM-102, so it can't finish multi-step work.
  - The Weekly Host Crontab Audit (TOM-90) can't see the host crontab from Hermes Runtime's container and needs a decision on a read-only host view.
