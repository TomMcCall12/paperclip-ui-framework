import { stepIdFromTitle } from "./step-key.js";

/**
 * Plain-English alert text for the stall sentinel (design section d).
 *
 * Each message is built from parts so that alert-only mode can swap the
 * "What I did" and "Next" sentences without a second copy of every template.
 * Board direction (21 Oct 2026) removed the Claude-to-OpenAI switch, so the
 * "provider switched" template (T1) and its variants do not exist; T2 always
 * means "waiting for the provider to come back".
 */

export const MAX_ALERT_LENGTH = 400;
const MIN_ROOT_LENGTH = 20;
const DEFAULT_ROOT_LENGTH = 50;
const LONDON = "Europe/London";

const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, year: "numeric", month: "2-digit", day: "2-digit" });
const weekdayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, weekday: "short" });

function londonDayNumber(date: Date): number {
  const parts = Object.fromEntries(dayFormat.formatToParts(date).map((p) => [p.type, p.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86_400_000;
}

/** "15:00" on the same London day, "tomorrow at 09:00", or "on Fri at 09:00". Includes "at". */
export function formatAt(date: Date, now: Date): string {
  const time = timeFormat.format(date);
  const days = londonDayNumber(date) - londonDayNumber(now);
  if (days === 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `on ${weekdayFormat.format(date)} at ${time}`;
}

/** Time without "at" for "from 09:07 to 11:19"; other days get the same prefixes. */
export function formatTime(date: Date, now: Date): string {
  return formatAt(date, now).replace(/^at /, "");
}

function plural(n: number, unit: string) {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** "42 minutes", "1 hour 5 minutes", "3 hours", "2 days", "over 7 days". */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? plural(hours, "hour") : `${plural(hours, "hour")} ${plural(rest, "minute")}`;
  }
  const days = Math.floor(hours / 24);
  return days >= 7 && ms > 7 * 86_400_000 ? "over 7 days" : plural(days, "day");
}

export function truncate(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** `S3 (TOM-718)` for a step, otherwise the identifier. */
export function leafLabel(issue: { title: string; identifier: string | null; id: string }): string {
  const ref = issue.identifier ?? issue.id.slice(0, 8);
  const step = stepIdFromTitle(issue.title);
  return step ? `${step} (${ref})` : ref;
}

export function issueRef(issue: { identifier: string | null; id: string }): string {
  return issue.identifier ?? issue.id.slice(0, 8);
}

/** "A, B, C and 3 more". */
export function formatList(items: readonly string[], limit: number): string {
  if (items.length <= limit) {
    if (items.length <= 1) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  }
  return `${items.slice(0, limit).join(", ")} and ${items.length - limit} more`;
}

export interface AlertParts {
  head: string;
  why?: string;
  did?: string;
  next?: string;
  /** Short phrase used by alert-only mode: "I would have {action}". Null: no heal for this template. */
  action?: string | null;
}

export type AlertTemplateId =
  | "T2" | "T2L" | "T3" | "T4" | "T5" | "T6" | "T7" | "T8" | "T9" | "T10" | "T10b"
  | "T11" | "T12" | "T13" | "T14" | "T15" | "T16" | "T17" | "TF";

export interface RenderContext {
  /** Alert-only wording, with the time self-repair starts (null: off by the operator). */
  alertOnly: { selfRepairFrom: string | null } | null;
}

function joinParts(parts: AlertParts, ctx: RenderContext): string {
  const segments = [parts.head];
  if (parts.why) segments.push(parts.why);
  if (ctx.alertOnly && parts.action) {
    segments.push(
      ctx.alertOnly.selfRepairFrom
        ? `Self-repair is off until ${ctx.alertOnly.selfRepairFrom}; I would have ${parts.action}.`
        : `Self-repair is off; I would have ${parts.action}.`,
    );
    segments.push("Next: Jarvis has been asked to do this by hand.");
  } else {
    if (parts.did) segments.push(parts.did);
    if (parts.next) segments.push(parts.next);
  }
  return segments.join(" ");
}

/**
 * Fills a template, then applies the length guard: the root title is cut
 * (to no less than 20 characters) and then a list is cut to "and N more" until
 * the text is under 400 characters.
 */
export function renderAlert(
  build: (fields: { root: string; listLimit: number }) => AlertParts,
  rootTitle: string,
  ctx: RenderContext,
  listLimit = 5,
): string {
  let rootLength = DEFAULT_ROOT_LENGTH;
  let limit = listLimit;
  let text = joinParts(build({ root: truncate(rootTitle, rootLength), listLimit: limit }), ctx);
  while (text.length >= MAX_ALERT_LENGTH && rootLength > MIN_ROOT_LENGTH) {
    rootLength -= 1;
    text = joinParts(build({ root: truncate(rootTitle, rootLength), listLimit: limit }), ctx);
  }
  while (text.length >= MAX_ALERT_LENGTH && limit > 1) {
    limit -= 1;
    text = joinParts(build({ root: truncate(rootTitle, rootLength), listLimit: limit }), ctx);
  }
  return text.length >= MAX_ALERT_LENGTH ? `${text.slice(0, MAX_ALERT_LENGTH - 2)}…` : text;
}

const stalled = (root: string, rid: string, age: string) => `Stalled: ${root} (${rid}). No progress for ${age}.`;

/** Values for the per-root templates. Times are already formatted with `formatAt`. */
export interface StallAlertValues {
  rid: string;
  age: string;
  leaf: string;
}

export const templates = {
  /** Waiting for provider usage; one wake is set for reset + 5 minutes. */
  T2: (v: StallAlertValues & { provider: string; atReset: string; atRestart: string; byCheck: string }) =>
    ({ root }: { root: string }): AlertParts => ({
      head: stalled(root, v.rid, v.age),
      why: `Why: ${v.leaf} is waiting for ${v.provider} usage, which comes back ${v.atReset}.`,
      did: `What I did: set it to restart ${v.atRestart}.`,
      next: `Next: nothing needed from you. I will tell you if it has not restarted by ${v.byCheck}.`,
      action: `set it to restart ${v.atRestart}`,
    }),
  /** Provider-locked: the assignee is a Codex agent and OpenAI has no usage. Sent once. */
  T2L: (v: StallAlertValues & { agent: string }) =>
    ({ root }: { root: string }): AlertParts => ({
      head: stalled(root, v.rid, v.age),
      why: `Why: ${v.leaf} is waiting on ${v.agent}, a Codex agent that has no OpenAI usage left.`,
      did: "What I did: nothing, because only that agent can do this step.",
      next: "Next: Jarvis has been asked to move it or wait. I will not repeat this message.",
      action: null,
    }),
  T3: (v: StallAlertValues & { agent: string; busyOn: string; since: string; atCheck: string }) =>
    ({ root }: { root: string }): AlertParts => ({
      head: `Waiting: ${root} (${v.rid}). No progress for ${v.age}.`,
      why: `Why: ${v.leaf} is queued for ${v.agent}, who has been busy on ${v.busyOn} since ${v.since}.`,
      did: "What I did: nothing, as moving work between agents is not safe.",
      next: `Next: Jarvis has been asked to move it or wait. I will check again ${v.atCheck}.`,
      action: null,
    }),
  T4: (v: StallAlertValues & { atHealed: string; atNext: string }) =>
    ({ root }: { root: string }): AlertParts => ({
      head: stalled(root, v.rid, v.age),
      why: `Why: nothing was working on ${v.leaf}; its run was lost.`,
      did: `What I did: restarted it ${v.atHealed}, but it has not started.`,
      next: `Next: Jarvis has been asked to look; nothing needed from you. I will tell you again ${v.atNext}.`,
      action: "restarted it",
    }),
  T5: (v: StallAlertValues & { ranFor: string; atHealed: string; atNext: string }) =>
    ({ root }: { root: string }): AlertParts => ({
      head: stalled(root, v.rid, v.age),
      why: `Why: ${v.leaf} kept running for ${v.ranFor} without saving any work.`,
      did: `What I did: stopped and restarted it ${v.atHealed}; it got stuck again.`,
      next: `Next: Jarvis has been asked to split or move it; nothing needed from you. I will tell you again ${v.atNext}.`,
      action: "stopped and restarted it",
    }),
  T6: (v: { rid: string; step: string; first: string; second: string }) =>
    ({ root }: { root: string }): AlertParts => ({
      head: `Check: ${root} (${v.rid}) has two open copies of step ${v.step}: ${v.first} and ${v.second}.`,
      why: "Why: both already have work, so I did not cancel either.",
      did: "What I did: nothing.",
      next: "Next: Jarvis has been asked to keep one; nothing needed from you.",
      action: null,
    }),
  T7: (v: StallAlertValues & { agent: string; atHealed: string; atNext: string }) =>
    ({ root }: { root: string }): AlertParts => ({
      head: stalled(root, v.rid, v.age),
      why: `Why: ${v.leaf} is marked blocked but does not say what it is waiting for.`,
      did: `What I did: asked ${v.agent} ${v.atHealed} to name the blocker or carry on.`,
      next: `Next: nothing needed from you. I will tell you again ${v.atNext}.`,
      action: `asked ${v.agent} to name the blocker`,
    }),
  /** Blocked with no blocker and no agent to ask. */
  T7n: (v: StallAlertValues & { atNext: string }) =>
    ({ root }: { root: string }): AlertParts => ({
      head: stalled(root, v.rid, v.age),
      why: `Why: ${v.leaf} is marked blocked but does not say what it is waiting for, and no agent owns it.`,
      did: "What I did: nothing, because there is no agent to ask.",
      next: `Next: Jarvis has been asked to look. I will tell you again ${v.atNext}.`,
      action: null,
    }),
  T8: (v: StallAlertValues & { blocker: string; agent: string; atHealed: string; atNext: string }) =>
    ({ root }: { root: string }): AlertParts => ({
      head: stalled(root, v.rid, v.age),
      why: `Why: ${v.leaf} waits for ${v.blocker}, which was cancelled, so it can never start.`,
      did: `What I did: asked ${v.agent} ${v.atHealed} to replace or remove that blocker.`,
      next: `Next: nothing needed from you. I will tell you again ${v.atNext}.`,
      action: `asked ${v.agent} to replace the blocker`,
    }),
  T9: (v: StallAlertValues & { step: string; atFinished: string; agent: string; atHealed: string; atNext: string }) =>
    ({ root }: { root: string }): AlertParts => ({
      head: stalled(root, v.rid, v.age),
      why: `Why: step ${v.step} finished ${v.atFinished}, but ${v.agent} has not picked it up.`,
      did: `What I did: woke ${v.agent} ${v.atHealed}; it has not started.`,
      next: `Next: nothing needed from you. I will tell you again ${v.atNext}.`,
      action: `woken ${v.agent}`,
    }),
  T10: (v: StallAlertValues & { agent: string; state: string; atNext: string }) =>
    ({ root }: { root: string }): AlertParts => ({
      head: stalled(root, v.rid, v.age),
      why: `Why: ${v.leaf} is assigned to ${v.agent}, which is ${v.state}, so it cannot start.`,
      did: "What I did: nothing, because I do not restart agents.",
      next: `Next: Jarvis has been asked to move the step. I will tell you again ${v.atNext}.`,
      action: null,
    }),
  T10b: (v: StallAlertValues & { atNext: string }) =>
    ({ root }: { root: string }): AlertParts => ({
      head: stalled(root, v.rid, v.age),
      why: "Why: Jarvis is paused, so nothing can be handed on.",
      did: "What I did: nothing, because I do not restart agents.",
      next: `Next: please open Paperclip and resume Jarvis. I will tell you again ${v.atNext}.`,
      action: null,
    }),
  T11: (v: { age: string; atNext: string }) =>
    (): AlertParts => ({
      head: `Paused: no new agent work has started for ${v.age}.`,
      why: "Why: Paperclip is holding all new runs.",
      did: "What I did: nothing, because someone set this hold on purpose.",
      next: `Next: if you did not plan this, open Paperclip and lift the hold. I will tell you again ${v.atNext}.`,
      action: null,
    }),
  T12: (v: StallAlertValues & { atNext: string }) =>
    ({ root }: { root: string }): AlertParts => ({
      head: stalled(root, v.rid, v.age),
      why: "Why: I cannot see a cause; nothing is running and nothing is waiting on you.",
      did: "What I did: nothing, because no automatic fix is safe.",
      next: `Next: Jarvis has been asked to look. I will tell you again ${v.atNext}.`,
      action: null,
    }),
  T13: (v: { rid: string; leaf: string; atProgress: string; stalledFor: string }) =>
    ({ root }: { root: string }): AlertParts => ({
      head: `Moving again: ${root} (${v.rid}). ${v.leaf} made progress ${v.atProgress}, after ${v.stalledFor} stalled. Nothing needed from you.`,
    }),
  /** Several "moving again" roots from one sweep. */
  T13g: (v: { rids: readonly string[] }) =>
    ({ listLimit }: { listLimit: number }): AlertParts => ({
      head: `Moving again: ${formatList(v.rids, listLimit)}. Nothing needed from you.`,
    }),
  T14: (v: { count: number; reason: string; rids: readonly string[]; did: string; next: string; action: string | null }) =>
    ({ listLimit }: { listLimit: number }): AlertParts => ({
      head: `Stalled: ${v.count} tasks, same reason: ${v.reason}. Tasks: ${formatList(v.rids, listLimit)}.`,
      did: `What I did: ${v.did}.`,
      next: `Next: ${v.next}`,
      action: v.action,
    }),
  T15: (v: { count: number; rids: readonly string[]; selfRepairStarts: string }) =>
    ({ listLimit }: { listLimit: number }): AlertParts => ({
      head: v.count === 0
        ? `Stall alarm started. No task was already stuck for over a day. Self-repair starts ${v.selfRepairStarts}. Nothing needed from you.`
        : `Stall alarm started. ${v.count} tasks were already stuck for over a day: ${formatList(v.rids, listLimit)}. I will remind you about them once a day at 09:00. Self-repair starts ${v.selfRepairStarts}. Nothing needed from you.`,
    }),
  T16: (v: { stalls: number; fixes: number }) =>
    (): AlertParts => ({
      head: `Stall alarm: self-repair is now on. In the last 24 hours I found ${v.stalls} stalls and would have made ${v.fixes} fixes. Nothing needed from you.`,
    }),
  T17: (v: { from: string; to: string; gap: string }) =>
    (): AlertParts => ({
      head: `Stall alarm: I was not running from ${v.from} to ${v.to} (${v.gap}).`,
      did: "What I did: checked every task again just now.",
      next: "Next: nothing needed from you; anything still stuck gets its own message.",
    }),
  /** Three failed sweeps in a row. */
  TF: () => (): AlertParts => ({
    head: "Stall alarm: my last 3 checks failed.",
    next: "Next: Jarvis has been asked to look.",
  }),
  /** Telegram cap overflow, sent at the next allowed time. */
  TCap: (v: { count: number }) => (): AlertParts => ({
    head: `Stall alarm: ${v.count} more stalls were found this hour. Each one has a comment on its task. Nothing needed from you.`,
  }),
} as const;
