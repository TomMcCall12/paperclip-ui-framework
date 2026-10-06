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
  - **First daily sweep (TOM-106):** reviewed 3 candidates and updated 3 Hermes skills. Every edit kept its `hermes-import` tag.
- **Rollback:** `docker-compose.yml.pre-tom53-*.bak`, or `pre-tom52`/`pre-tom50`. To drop protection, `DELETE /api/companies/{id}/skill-policy`.
- **Open for Tom:**
  - **The Software Engineer's role:** it has Bash, Read and Skill tools only, a 16-turn cap and a 7-minute timeout. The daily sweep (TOM-106) proposed a routing note for Jarvis, citing a "board" comment on TOM-77. That comment was actually written by the Lab session, not by Tom. Tom will choose between a routing note and upgrading the agent.
  - **Weekly Host Crontab Audit (TOM-90):** Tom approved read-only host access for Hermes Runtime on 6 Oct.
    - The report script is installed at `/DATA/AppData/host-readonly-audit/host-readonly-audit.sh` (read-only; sections all, schedule, backups, services).
    - Authorizing its restricted SSH key was blocked by the Lab session's safety check and needs Tom's explicit permission, so TOM-90 stays blocked.
  - TOM-50 and TOM-85 were cancelled at Tom's request.

## 6 Oct: Tom's follow-ups (image `tom54`)
- **Google:** nothing to reconnect.
  - Tom re-authorised Hermes's Google sign-in on 5 Oct, and backups have succeeded since (the 6 Oct 03:17 run completed).
  - The September failures were Google Drive rate limits.
- **Software Engineer:** now a full coding agent. Tom approved each command after leaving auto mode.
  - Sonnet 5 at medium effort, the full Claude toolset, no step cap, a 2-hour timeout, and its own workspace.
  - An "Engineering" section in its instructions, including the shipping rule.
- **Jarvis picks the agent and model per task:**
  - His AGENTS.md has an agent table and model guide, and tells him to override only model and effort.
  - Verified on TOM-107: the Opus-default advisor ran on Haiku for that task.
- **Task overrides are locked down (`fd18a0b`):** local Claude, Codex and OpenCode agents now accept only model, effort, run budget and workspace strategy. Before, a task could change tools, permissions or arguments.
- **"Find a way" rule (`29b7a93`):** every task tries at least two other routes before marking anything failed, never defeats a CAPTCHA, and saves a route that worked. Jarvis's brand-name rule names TMview and WIPO's Global Brand Database for UK marks.
- **Read-only host access for Hermes Runtime:** a key limited to `/DATA/AppData/host-readonly-audit/host-readonly-audit.sh` and to connections from the ZimaBoard itself.
  - TOM-90 completed using it.
  - It found host cron faults for Tom: `MAILTO=""` fails to parse, `sys-hourly` exits 127, and there is no mail program.
- **Cancelled at Tom's request:** TOM-50 and TOM-85.

## 6 Oct afternoon: notifications, Telegram requests, Hermes independence (images `tom55` to `tom58`)
- **Task notifications on Telegram (`432734e`, `d1edfb2`):** the experimental setting "Task notifications" messages Tom through @toms_lab_jarvis_bot when an agent finishes, blocks on or hands back a top-level task. Tom confirmed it arrives.
- **Telegram requests:** Jarvis's AGENTS.md now has "Requests from Telegram and chats".
  - Real work becomes a top-level task with a matching or new project, one to three labels, and the best agent and model.
  - Missing capabilities become a blocking Software Engineer task.
  - Starter labels: Research, Plated, Tom's Lab, Personal, Finance, Admin.
- **Hermes independence:**
  - UXDesigner, the Plated QA Gatekeeper and the Research Lead moved to Claude (Sonnet 5).
  - A real browser is in the image: Chromium plus Xvfb in the host overlay, live from `tom57`.
  - TOM-112 brings the Hermes history into the vault.
- **Long gateway runs lost their writes (`1fa10a7`, `tom58`):** the prompt said never to repeat the run token, so after Hermes summarised a long run the agent retyped it wrongly ("Agent token did not verify"; TOM-99 and TOM-113). Agents now save the headers to a private file and use `curl -H @file`.
- **Self-editing:** the Software Engineer has a full clone of Tom's Lab's code. The host update command, which deploys only commits Tom approved and rolls back automatically, was blocked by the Lab session's safety check, and needs Tom to approve each command. The private GitHub repo is still to do.
- **Self-update is live (6 Oct evening, approved by Tom command by command):**
  - The host command `/DATA/AppData/lab-update/lab-update.sh` is reachable only from inside Tom's Lab, with the key at `/paperclip/lab-update/agent_key`.
  - It offers `report`, `status`, and `deploy <commit> <TASK>`. Deploy runs only when the commit builds on live and Tom accepted a confirmation naming it. It then builds, waits for idle, deploys, health-checks and rolls back automatically.
  - The protected skill `toms-lab-self-update` is with Jarvis and the Software Engineer.
  - The weekly host check now runs on the Software Engineer with `report all`, not on Hermes.
  - TOM-114 sets up the private GitHub repository.
- **Google through Tom's Claude account (`2238764`, image `tom59`):**
  - Google's Workspace MCP servers return 403 to Tom's own OAuth client (Developer Preview enrolment).
  - The Claude account Tom's Lab signs in with already has Google Sheets, Drive, Gmail and Calendar.
  - The new per-agent setting "Use my Claude account's connectors" (default off, not task-overridable) is on for Jarvis only.
  - Deployment and a read-only check are scheduled once agents are idle.

## 6 Oct evening: "tasks shouldn't just fail"
- **Macro Chef (TOM-129):** Hermes Runtime finished the work (Expo running, EAS iOS dev build done), but its status writes got 401. Disposition repair gave up after two tries and left a jargon board note, so the task looked failed.
- **Task watchdog switched on:**
  - A new Watchdog agent (Sonnet 5) carries Tom's rule: fix it yourself, and ask Tom only for what only he can do, in plain English.
  - Jarvis attaches it to every top-level task.
  - First live run on TOM-116: it verified the work had been done and found TOM-129 running again.
- **Hermes Runtime:** run limit is now 2 hours, and the stale "disabled-until-https" metadata label is gone.
- **401 diagnosis (`216c87d`):** agent credential refusals are now logged with the reason and claims (never the token). It ships with the pending quiet-window update.

