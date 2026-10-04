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
