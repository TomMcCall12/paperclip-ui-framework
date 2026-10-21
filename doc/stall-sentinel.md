# Stall sentinel

The stall sentinel (the "stall alarm") makes silent stalls impossible. It runs
inside the Paperclip server every 2 minutes. It finds open work that has made no
progress, fixes the simple causes itself, and tells the board on Telegram, in
plain English, when it cannot.

It calls no model and no agent adapter, so it keeps working when Claude or
OpenAI usage is spent. Its only outside calls are the Telegram board notice and
the provider usage (quota) probes that `GET /costs/quota-summary` also uses.

Code: `server/src/services/stall-sentinel/`. Design source: the `stall-design`
document on the S2 step of TOM-713.

## What it watches

For every active company, a **watched tree** is:

- each open Line root (`lines.root_issue_id`) with all its descendants; and
- each open top-level issue outside a Line with all its descendants.

"Open" is `todo`, `in_progress`, `in_review` or `blocked`. Not watched: closed,
backlog and hidden roots, chat conversations, trees with no agent assignee on any
open issue (for example the board's own to-do items), and top-level recovery or
watchdog review issues (their source trees are watched instead).

Inside a tree the sentinel finds the **frontier**: it follows `blocked` issues to
their open blockers (also across trees) and parents to their open children,
until it reaches the issues that should move next.

**Progress** is the newest of these on any issue in the tree: an agent or user
comment (not from a failed run), a new document revision, a work product
change, an agent or user status change, a succeeded run, a running run, or the
creation of the task. System comments (recovery, watchdog and the sentinel's
own), failed runs, queued runs and wake requests are not progress.

A task waiting on the board (a pending card or approval, a user assignee, or a
user unblock owner anywhere on its path) is never a stall.

## Causes and what the sentinel does

Times are from the last progress in the tree unless shown otherwise. Routine
executions double every time (the unknown-cause backstop is 4 hours).

| Cause | Detected when | Self-repair (mode `on`) | Board alert |
|---|---|---|---|
| P, provider usage | The latest run failed with `provider_quota`, or a queued run waits for a provider that is out | Claude out: never switch provider; one wake at `resetsAt` + 5 min. A task a Claude agent would run on OpenAI (a `codex_local` override or an OpenAI model) is moved back to `claude_local` | Claude out: at once ("waiting for Claude usage, which comes back at HH:MM"). Not out: only if not restarted 15 min after the reset. Codex agent with no Claude override: one message, never repeated |
| R, stuck run | Running with no output for 60 min (the active-run watchdog's suspicion time, so one long silent tool call is not killed), or past `timeoutSec` + 15 min | First time in 24 h: cancel the run and queue a resume wake | Second stuck run |
| Q, busy agent | Queued for an agent that is running another issue | None (alert only) | 30 min queued |
| Q2, idle queued run | Queued for an idle agent | 10 min: re-queue | 15 min after the re-queue |
| L, lost run | Agent assignee, runnable status, no run and no queued wake | 10 min: re-queue | 15 min after the re-queue |
| A, agent paused or in error | The assignee is paused, in error or terminated | None (governance decision) | 15 min. Jarvis paused: asks the board to resume Jarvis |
| C, cancelled blocker | Blocked on a cancelled task | 15 min after the cancel: wake the parent's agent (or the task's own agent at the top level) | 30 min after the wake |
| B, blocked with no blocker | Blocked, no blocker, no unblock owner | 30 min: wake the assignee once with a "name the blocker or carry on" message | 30 min after the wake; at once when there is no agent |
| K, checkpoint not picked up | A child finished, the parent is blocked on it with other blockers open, and the parent had no run since | 15 min after the child finished: wake the parent's agent once per child | 30 min after the wake |
| M, monitor wait | `monitor_next_check_at` is set | Not a stall until that time + 15 min; then as L | As L |
| D, duplicate step | Two open siblings with the same step key (`S3:`, `S5e:`, `S3-r2:`) | Cancel the newer copy only if it has no run, no agent or user comment, no document, no work product and blocks nothing | At once if neither copy is safe to cancel |
| H, all runs held | Scheduling is suppressed | None (the hold is on purpose) | 60 min after the hold started |
| U, unknown | None of the above | None | 3 hours (backstop) |

Rules that apply to every self-repair:

- One `stall_sentinel.healed` activity row (actor `system` / `stall-sentinel`)
  and one comment on the root task.
- An issue with an active recovery action is left to the recovery loop; only
  the backstop alert applies. The sentinel never writes
  `issue_recovery_actions`.
- At most once per issue and cause in 24 hours. A lost run and a queued run that
  never started share one restart. A second occurrence gives an alert. When the
  restart did start a run and the task then stops again, that is a new stall: its
  clock starts from that run, and it alerts at the normal after-restart time with
  "it ran, then stopped again" instead of a second restart.
- Wakes use `heartbeat.wakeup` with `source: automation`, a
  `stall-sentinel:<cause>:<issueId>:<statusVersion>` idempotency key and an issue
  state guard, so a wake is dropped if the task changed meanwhile.
- The sentinel's comments are system comments. The comment service wakes nobody
  for them. When an alert asks Jarvis to act, the comment mentions Jarvis and the
  sentinel queues one `stall_sentinel_reroute` wake for Jarvis (mode `on` only).
  A task that still has open blockers normally ignores automatic wakes. Exactly
  three sentinel wake reasons are let through, in the same bounded triage mode as a
  comment wake: `stall_sentinel_checkpoint_done`, `stall_sentinel_cancelled_blocker`
  and `stall_sentinel_reroute` (`allowsDependencyBlockedWake`), and only when the
  wake carries the `stallSentinelWake` marker. `enqueueWakeup` sets that marker
  itself for system wakes requested by `stall-sentinel` and strips it from every
  other caller, so an agent cannot wake itself past the gate with these reasons.
  Every other automatic wake is still skipped.
- If a wake is dropped (the port answers "not queued"), the heal is recorded with
  `asked: false`, the root comment says so, and the later alert says no cause is
  visible. It never says "woke X, who has not picked it up".
- A wake only counts as already queued while it is still waiting (`queued`,
  `claimed`, `deferred_issue_execution`). A finished wake with the same key does
  not block a new one after the 24 hour cooldown.
- The 60 second sweep limit stops the sweep: no second sweep starts until the
  first has stopped, and a late sweep sends and writes nothing more. No mention when
  Jarvis's own provider is out or Jarvis is the stuck or paused agent.

### Provider rule (board direction, 21 Oct 2026)

Claude is "out" when the session window has **under 20%** left and resets
**more than 60 minutes** away, or the weekly window has **under 15%** left. The
comparisons are strict (20% or exactly 60 minutes is not out). Usage comes from
`fetchAllQuotaWindows` and `summarizeQuotaWindows`, cached for 5 minutes per
company.

- The sentinel **never moves work from Claude to OpenAI**.
- A task that a Claude-based agent would run on OpenAI is rewritten to
  `claude_local` (gpt-6-sol xhigh → claude-opus-5-5 high; gpt-6-sol high →
  claude-sonnet-5-5 high; gpt-6-sol medium/low → claude-sonnet-5-5 medium;
  gpt-5.4-mini → claude-haiku-4-5; an unmapped OpenAI model is dropped so the
  agent's own Claude model is used). The old overrides are saved in the activity
  row. This is a silent repair (comment and activity only).
- Provider-locked tasks are not rewritten: the assignee is a Codex agent with no
  Claude override, the task has the `provider-locked` label, or a person set the
  override in the last 2 hours.

## Alerts, de-duplication and rate limits

Telegram goes through `sendBoardTelegramNotice` (`app.locals`), independent of
the task-notifications setting. The same text is written as a comment on the
root task. If Telegram fails, the comment is still written and the reason goes
in the activity row and in health (`lastDeliveryError`, never a token).

- Times are Europe/London, 24-hour ("at 15:00", "tomorrow at 09:00",
  "on Fri at 09:00"). Every message is under 400 characters.
- Fingerprint `sha256(company | root | cause | frontier)`; the same stall is
  repeated at most every 60 minutes. Stalls older than 24 hours repeat once a day
  at 09:00. The Codex-agent provider alert is sent once.
- One message per root per 15 minutes; at most 6 Telegram messages per company
  per hour (the rest become one "N more stalls" message at the next allowed time;
  comments are not capped).
- Alerts with the same reason in one sweep (same provider reset, same busy run,
  same paused agent, or routine runs with the same cause) become one message.
- "Moving again" is sent once when a root that had a Telegram alert makes
  progress. Silent repairs never send Telegram.
- State lives in the sentinel's own activity rows (`stall_sentinel.alerted`,
  `.healed`, `.would_heal`, `.cleared`, `.rollout`). On start the last 24 hours
  are read back, so a restart never repeats early.

## Kill switch and rollout

`PAPERCLIP_STALL_SENTINEL_MODE` in the host env file (read at server start):

- `off`: no sweeps, no actions, no alerts. Health shows `mode: "off"` and the
  host check passes.
- `alert_only`: sweeps, comments and alerts, but no self-repair and no wake at
  all (not even the Jarvis reroute wake). Alerts come at the cause's own alert
  time (heal-due time plus the wait that follows a heal), and their text says
  Jarvis was not woken. No issue field changes (status, assignee, blockers, overrides), no
  run is cancelled, and no repair wake is queued. A would-be repair is logged as
  `stall_sentinel.would_heal` and the alert says "Self-repair is off; I would have
  …. Next: Jarvis has been asked to do this by hand."
- `on` (default): full behaviour after the rollout window.

**Rollout:** on the first sweep in mode `on` the sentinel writes a
`stall_sentinel.rollout` row and sends a start message that lists trees already
stuck for over a day. For the next 24 hours (`PAPERCLIP_STALL_SENTINEL_ROLLOUT_HOURS`)
it behaves as `alert_only`. Then it switches to self-repair by itself and sends
one message ("self-repair is now on"). No restart is needed.

**Emergency stop:** Tom's Labs Engineer sets `PAPERCLIP_STALL_SENTINEL_MODE=off`
(or `alert_only`) in the host env file through the loopback root route
(`toms-lab-self-update` skill) and restarts the service at a quiet moment.

`PAPERCLIP_STALL_SENTINEL_THRESHOLD_SCALE` (dev and test only; ignored when
`NODE_ENV=production`) multiplies every time so a test instance can prove the
timings quickly. `PAPERCLIP_STALL_SENTINEL_COORDINATOR_AGENT_ID` /
`_AGENT_NAME` (default name `Jarvis`) choose the agent that is asked to reroute.

## Health contract

Every `/api/health` response, including the redacted anonymous one, carries:

```json
"stallSentinel": {
  "mode": "on",
  "effectiveMode": "alert_only",
  "startedAt": "2026-10-22T09:00:00.000Z",
  "lastSweepAt": "2026-10-22T09:12:00.000Z",
  "lastSweepOk": true
}
```

Full-detail callers also get `lastSweepDurationMs`, `consecutiveFailures`,
`openStalls`, `lastAlertAt` and `lastDeliveryError`. No task data is included.

Freshness rule for the host check (`isStallSentinelFresh` in `health-state.ts`):
pass when `mode` is `off`; pass when `lastSweepAt` is within 10 minutes and
`lastSweepOk` is true; pass when there is no sweep yet and `startedAt` is within
10 minutes; otherwise fail. A missing field fails (older build).

## Server wiring

- `server/src/index.ts`: the sentinel's `tick()` runs on every heartbeat
  scheduler tick (30 s), before the scheduling-suppression check, and in the
  scheduler-disabled branch. It skips a tick within 2 minutes of the last sweep
  start or while a sweep runs. Each sweep has a 60 s limit; after 3 failures in a
  row one plain message is sent ("my last 3 checks failed") to the companies of
  the last good sweep, and health makes the host check fail.
- `server/src/app.ts`: `app.locals.sendBoardTelegramNotice`.
- `server/src/routes/health.ts`: the `stallSentinel` field.
- The last sweep time is also written to `<instance root>/stall-sentinel-state.json`.
  When the server starts and that time is more than 10 minutes old, the sentinel
  sends one "I was not running from … to …" message and checks everything again.

## Tests

```sh
cd server
npx vitest run src/services/stall-sentinel src/__tests__/health-stall-sentinel.test.ts
```

`sweep.test.ts` covers every cause, the healthy tree, rate limits, the kill
switch, rollout and the provider rule; `actions.test.ts` runs against embedded
Postgres (system comments wake nobody, the loader reads a real tree, an
`alert_only` sweep changes no task row, and the Claude rewrite passes the API's
override validation).
