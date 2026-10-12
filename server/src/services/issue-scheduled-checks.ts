import { and, asc, eq, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, issueScheduledChecks, issues } from "@paperclipai/db";
import type {
  CreateIssueScheduledCheckInput,
  IssueExecutionMonitorPolicy,
  IssueScheduledCheck,
  IssueScheduledCheckRunNowResponse,
  UpdateIssueScheduledCheckInput,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import type { ActivityPublication, LogActivityInput } from "./activity-log.js";

/**
 * CRUD + dispatch for `issue_scheduled_checks` (TOM-413). An issue can have
 * any number of these rows, unlike the legacy single `executionPolicy.monitor`
 * / `issues.monitor_*` columns. The row with `isPrimary: true` for a given
 * creator mirrors that legacy field so the back-compat PATCH path (see
 * `syncPrimaryScheduledCheckFromExecutionPolicy` below) keeps working without
 * the caller knowing this table exists.
 *
 * Dispatch scope decision (documented here since it affects correctness):
 * the *primary* row for an issue continues to be dispatched by the existing
 * `tickDueIssueMonitors` / `dispatchClaimedIssueMonitor` loop in
 * `server/src/services/heartbeat.ts`, which operates directly on
 * `issues.monitor_*` columns and already has all of the assignee/status
 * gating, provider-quota-monitor special-casing, and recovery-policy logic
 * for that one row. `syncPrimaryScheduledCheckFromExecutionPolicy` keeps the
 * primary `issue_scheduled_checks` row's `next_check_at` / `notes` /
 * `attempt_count` / `last_triggered_at` mirrored from the legacy columns (and
 * vice versa is not needed, since the legacy columns remain authoritative for
 * that row) purely so it shows up in the Properties panel list and `run-now`
 * works consistently.
 *
 * `tickDueIssueScheduledChecks` below only dispatches *non-primary* rows
 * (the new "many check-ins" case). This avoids double-firing a primary row
 * that the legacy loop already claims via `monitor_wake_requested_at`. If
 * multiple non-primary rows are due for the same issue at once, they are
 * coalesced into a single wake call with combined notes rather than firing
 * once per row.
 */

function toApi(row: typeof issueScheduledChecks.$inferSelect): IssueScheduledCheck {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    nextCheckAt: row.nextCheckAt ? row.nextCheckAt.toISOString() : null,
    notes: row.notes ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    status: row.status as IssueScheduledCheck["status"],
    attemptCount: row.attemptCount,
    lastTriggeredAt: row.lastTriggeredAt ? row.lastTriggeredAt.toISOString() : null,
    recurrenceCron: row.recurrenceCron ?? null,
    recurrenceTimezone: row.recurrenceTimezone ?? null,
    cancelOnComment: row.cancelOnComment,
    isPrimary: row.isPrimary,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    cancelReason: row.cancelReason ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Minimal support for the 5-field cron subset accepted by
 * `createIssueScheduledCheckSchema` / `updateIssueScheduledCheckSchema`:
 * `minute hour * * *` (daily) or `minute hour * * dayOfWeek` (weekly).
 * Anything else — including real cron ranges/steps/lists — returns null, so
 * the check-in is treated as one-shot (fires once, then `status: "fired"`,
 * never rescheduled). No cron library dependency is introduced; the server
 * and root package.json have none today.
 *
 * Timezone handling is approximate: we compute the next occurrence in UTC
 * offset terms by formatting "now" in the target IANA timezone via
 * `Intl.DateTimeFormat`, finding the next matching minute/hour/day-of-week,
 * then converting that wall-clock time back to a UTC Date. This is accurate
 * for all but DST-transition instants, which is an acceptable approximation
 * for a "remind me daily around HH:MM" feature.
 */
export function computeNextCronOccurrence(
  cron: string | null | undefined,
  timezone: string | null | undefined,
  after: Date,
): Date | null {
  if (!cron || !timezone) return null;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteStr, hourStr, dom, month, dow] = fields;
  if (dom !== "*" || month !== "*") return null;
  const minute = Number(minuteStr);
  const hour = Number(hourStr);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  let targetDow: number | null = null;
  if (dow !== "*") {
    targetDow = Number(dow);
    if (!Number.isInteger(targetDow) || targetDow < 0 || targetDow > 6) return null;
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return null;
  }

  // Walk forward day by day (max 8 days covers daily + weekly) looking for
  // the first candidate strictly after `after` whose local wall-clock time
  // in `timezone` matches hour:minute (and day-of-week, if constrained).
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const candidateUtcMidnight = new Date(
      Date.UTC(
        after.getUTCFullYear(),
        after.getUTCMonth(),
        after.getUTCDate() + dayOffset,
        0,
        0,
        0,
      ),
    );
    // Search across a window of UTC instants that could plausibly map to
    // hour:minute local time on this UTC date, accounting for timezone
    // offsets up to +/-14h.
    for (let minuteOfDay = 0; minuteOfDay < 24 * 60; minuteOfDay += 1) {
      const candidate = new Date(
        candidateUtcMidnight.getTime() + minuteOfDay * 60_000,
      );
      if (candidate.getTime() <= after.getTime()) continue;
      const parts = formatter.formatToParts(candidate);
      const partMap = new Map(parts.map((p) => [p.type, p.value]));
      const localHour = Number(partMap.get("hour"));
      const localMinute = Number(partMap.get("minute"));
      if (localHour !== hour || localMinute !== minute) continue;
      if (targetDow !== null) {
        const weekdayShort = partMap.get("weekday");
        const dowIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
          weekdayShort ?? "",
        );
        if (dowIndex !== targetDow) continue;
      }
      return candidate;
    }
  }
  return null;
}

export async function listIssueScheduledChecks(
  db: Db,
  issueId: string,
): Promise<IssueScheduledCheck[]> {
  const rows = await db
    .select()
    .from(issueScheduledChecks)
    .where(eq(issueScheduledChecks.issueId, issueId))
    .orderBy(asc(issueScheduledChecks.nextCheckAt));
  return rows.map(toApi);
}

export async function getIssueScheduledCheckById(
  db: Db,
  issueId: string,
  checkId: string,
): Promise<IssueScheduledCheck | null> {
  const [row] = await db
    .select()
    .from(issueScheduledChecks)
    .where(
      and(
        eq(issueScheduledChecks.id, checkId),
        eq(issueScheduledChecks.issueId, issueId),
      ),
    )
    .limit(1);
  return row ? toApi(row) : null;
}

export async function createIssueScheduledCheck(
  db: Db,
  params: {
    companyId: string;
    issueId: string;
    createdByAgentId?: string | null;
    createdByUserId?: string | null;
    input: CreateIssueScheduledCheckInput;
  },
): Promise<IssueScheduledCheck> {
  const [row] = await db
    .insert(issueScheduledChecks)
    .values({
      companyId: params.companyId,
      issueId: params.issueId,
      nextCheckAt: new Date(params.input.nextCheckAt),
      notes: params.input.notes ?? null,
      createdByAgentId: params.createdByAgentId ?? null,
      createdByUserId: params.createdByUserId ?? null,
      recurrenceCron: params.input.recurrenceCron ?? null,
      recurrenceTimezone: params.input.recurrenceTimezone ?? null,
      cancelOnComment: params.input.cancelOnComment ?? false,
      status: "scheduled",
      isPrimary: false,
    })
    .returning();
  return toApi(row);
}

export async function updateIssueScheduledCheck(
  db: Db,
  params: { issueId: string; checkId: string; input: UpdateIssueScheduledCheckInput },
): Promise<IssueScheduledCheck> {
  const existing = await getIssueScheduledCheckById(db, params.issueId, params.checkId);
  if (!existing) throw notFound("Scheduled check not found");

  const patch: Partial<typeof issueScheduledChecks.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (params.input.nextCheckAt !== undefined) {
    patch.nextCheckAt = new Date(params.input.nextCheckAt);
  }
  if (params.input.notes !== undefined) patch.notes = params.input.notes;
  if (params.input.recurrenceCron !== undefined) {
    patch.recurrenceCron = params.input.recurrenceCron;
  }
  if (params.input.recurrenceTimezone !== undefined) {
    patch.recurrenceTimezone = params.input.recurrenceTimezone;
  }
  if (params.input.cancelOnComment !== undefined) {
    patch.cancelOnComment = params.input.cancelOnComment;
  }
  if (params.input.status !== undefined) {
    patch.status = params.input.status;
    if (params.input.status === "cancelled") {
      patch.cancelledAt = new Date();
      patch.cancelReason = "manual";
    }
  }

  const [row] = await db
    .update(issueScheduledChecks)
    .set(patch)
    .where(
      and(
        eq(issueScheduledChecks.id, params.checkId),
        eq(issueScheduledChecks.issueId, params.issueId),
      ),
    )
    .returning();
  if (!row) throw notFound("Scheduled check not found");
  return toApi(row);
}

export async function cancelIssueScheduledCheck(
  db: Db,
  params: { issueId: string; checkId: string; reason?: string },
): Promise<IssueScheduledCheck> {
  const [row] = await db
    .update(issueScheduledChecks)
    .set({
      status: "cancelled",
      cancelledAt: new Date(),
      cancelReason: params.reason ?? "deleted",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(issueScheduledChecks.id, params.checkId),
        eq(issueScheduledChecks.issueId, params.issueId),
      ),
    )
    .returning();
  if (!row) throw notFound("Scheduled check not found");
  return toApi(row);
}

/**
 * Upsert (or clear) the single `isPrimary: true` row for (issueId, creator)
 * from the legacy `executionPolicy.monitor` PATCH payload. Called from the
 * issue update route whenever `monitorChanged` is true, so the new table
 * stays in lockstep with `issues.monitor_*` without the PATCH caller having
 * to know about `issue_scheduled_checks`.
 *
 * `monitor: null` mirrors how the existing route clears a monitor: the
 * primary row is marked cancelled (not hard-deleted) with
 * `cancelReason: "execution_policy_cleared"`, consistent with
 * `buildIssueMonitorClearedPatch` setting `issues.monitor_next_check_at =
 * null` rather than deleting monitor history.
 */
export async function syncPrimaryScheduledCheckFromExecutionPolicy(
  db: Db,
  params: {
    companyId: string;
    issueId: string;
    monitor: IssueExecutionMonitorPolicy | null;
    createdByAgentId?: string | null;
    createdByUserId?: string | null;
  },
): Promise<void> {
  const [existingPrimary] = await db
    .select()
    .from(issueScheduledChecks)
    .where(
      and(
        eq(issueScheduledChecks.issueId, params.issueId),
        eq(issueScheduledChecks.isPrimary, true),
      ),
    )
    .limit(1);

  if (!params.monitor) {
    if (existingPrimary && existingPrimary.status !== "cancelled") {
      await db
        .update(issueScheduledChecks)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelReason: "execution_policy_cleared",
          updatedAt: new Date(),
        })
        .where(eq(issueScheduledChecks.id, existingPrimary.id));
    }
    return;
  }

  const nextCheckAt = new Date(params.monitor.nextCheckAt);
  const notes = params.monitor.notes ?? null;

  if (existingPrimary) {
    await db
      .update(issueScheduledChecks)
      .set({
        nextCheckAt,
        notes,
        status: "scheduled",
        cancelledAt: null,
        cancelReason: null,
        updatedAt: new Date(),
      })
      .where(eq(issueScheduledChecks.id, existingPrimary.id));
    return;
  }

  await db.insert(issueScheduledChecks).values({
    companyId: params.companyId,
    issueId: params.issueId,
    nextCheckAt,
    notes,
    createdByAgentId: params.createdByAgentId ?? null,
    createdByUserId: params.createdByUserId ?? null,
    status: "scheduled",
    isPrimary: true,
  });
}

type WakeupFn = (
  agentId: string,
  opts: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown>;

type LogActivityFn = (
  db: Db,
  entry: LogActivityInput,
  postCommitPublications?: ActivityPublication[],
) => Promise<unknown>;

/**
 * Dispatch every *non-primary* scheduled check row that is due. Primary rows
 * stay on the legacy `tickDueIssueMonitors` loop — see the module doc comment
 * above for why. Rows due for the same issue are coalesced into a single
 * wake call with their notes joined, and each row is then individually
 * marked fired/rescheduled so "run now" (which reuses this same function for
 * a single row) behaves identically to the automatic path.
 */
export async function tickDueIssueScheduledChecks(
  db: Db,
  deps: { wakeup: WakeupFn; logActivity: LogActivityFn },
  now: Date = new Date(),
): Promise<{ checked: number; triggered: number; coalescedIssues: number }> {
  const scheduledCheckColumns = {
    id: issueScheduledChecks.id,
    companyId: issueScheduledChecks.companyId,
    issueId: issueScheduledChecks.issueId,
    nextCheckAt: issueScheduledChecks.nextCheckAt,
    notes: issueScheduledChecks.notes,
    createdByAgentId: issueScheduledChecks.createdByAgentId,
    createdByUserId: issueScheduledChecks.createdByUserId,
    status: issueScheduledChecks.status,
    attemptCount: issueScheduledChecks.attemptCount,
    lastTriggeredAt: issueScheduledChecks.lastTriggeredAt,
    wakeRequestedAt: issueScheduledChecks.wakeRequestedAt,
    recurrenceCron: issueScheduledChecks.recurrenceCron,
    recurrenceTimezone: issueScheduledChecks.recurrenceTimezone,
    cancelOnComment: issueScheduledChecks.cancelOnComment,
    cancelledAt: issueScheduledChecks.cancelledAt,
    cancelReason: issueScheduledChecks.cancelReason,
    isPrimary: issueScheduledChecks.isPrimary,
    createdAt: issueScheduledChecks.createdAt,
    updatedAt: issueScheduledChecks.updatedAt,
  };

  const rows = await db
    .select(scheduledCheckColumns)
    .from(issueScheduledChecks)
    .innerJoin(companies, eq(companies.id, issueScheduledChecks.companyId))
    .where(
      and(
        eq(companies.status, "active"),
        eq(issueScheduledChecks.status, "scheduled"),
        eq(issueScheduledChecks.isPrimary, false),
        lte(issueScheduledChecks.nextCheckAt, now),
      ),
    )
    .orderBy(asc(issueScheduledChecks.nextCheckAt))
    .limit(200);

  if (rows.length === 0) {
    return { checked: 0, triggered: 0, coalescedIssues: 0 };
  }

  const byIssue = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byIssue.get(row.issueId) ?? [];
    list.push(row);
    byIssue.set(row.issueId, list);
  }

  let triggered = 0;
  for (const [issueId, issueRows] of byIssue) {
    const result = await dispatchIssueScheduledCheckRows(db, deps, issueId, issueRows, now);
    triggered += result.triggered;
  }

  return { checked: rows.length, triggered, coalescedIssues: byIssue.size };
}

/**
 * Dispatch a specific set of rows for one issue (shared by the periodic tick
 * above and the `run-now` route, which calls this with exactly one row so
 * "run now" and "fired because due" share the same wake/reschedule logic).
 */
export async function dispatchIssueScheduledCheckRows(
  db: Db,
  deps: { wakeup: WakeupFn; logActivity: LogActivityFn },
  issueId: string,
  rowsToDispatch: Array<typeof issueScheduledChecks.$inferSelect>,
  now: Date = new Date(),
): Promise<{ triggered: number }> {
  if (rowsToDispatch.length === 0) return { triggered: 0 };

  const [issue] = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue) return { triggered: 0 };
  if (!issue.assigneeAgentId || issue.assigneeUserId) return { triggered: 0 };
  if (!["in_progress", "in_review"].includes(issue.status)) return { triggered: 0 };

  const combinedNotes = rowsToDispatch
    .map((r) => r.notes)
    .filter((n): n is string => Boolean(n && n.trim().length > 0))
    .join("\n\n");

  await deps.wakeup(issue.assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_scheduled_check_due",
    idempotencyKey: `issue-scheduled-check:${issueId}:${rowsToDispatch
      .map((r) => r.id)
      .sort()
      .join(",")}:${now.getTime()}`,
    payload: {
      issueId,
      notes: combinedNotes || null,
      scheduledCheckIds: rowsToDispatch.map((r) => r.id),
    },
    requestedByActorType: "system",
    requestedByActorId: "heartbeat_scheduler",
    contextSnapshot: {
      issueId,
      source: "issue.scheduled_check",
      wakeReason: "issue_scheduled_check_due",
      scheduledCheckIds: rowsToDispatch.map((r) => r.id),
    },
  });

  for (const row of rowsToDispatch) {
    const nextOccurrence = computeNextCronOccurrence(
      row.recurrenceCron,
      row.recurrenceTimezone,
      now,
    );
    await db
      .update(issueScheduledChecks)
      .set(
        nextOccurrence
          ? {
              attemptCount: row.attemptCount + 1,
              lastTriggeredAt: now,
              nextCheckAt: nextOccurrence,
              status: "scheduled",
              updatedAt: new Date(),
            }
          : {
              attemptCount: row.attemptCount + 1,
              lastTriggeredAt: now,
              status: "fired",
              updatedAt: new Date(),
            },
      )
      .where(eq(issueScheduledChecks.id, row.id));

    await deps.logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "heartbeat_scheduler",
      action: "issue.scheduled_check_fired",
      entityType: "issue",
      entityId: issueId,
      details: {
        identifier: issue.identifier,
        scheduledCheckId: row.id,
        notes: row.notes,
        rescheduled: Boolean(nextOccurrence),
        nextCheckAt: nextOccurrence ? nextOccurrence.toISOString() : null,
      },
    });
  }

  return { triggered: 1 };
}

/**
 * Force-trigger a single scheduled check immediately, reusing the same
 * dispatch logic as the due-check tick so "run now" and "fired because due"
 * behave identically. Returns `outcome: "skipped"` (without throwing) if the
 * issue isn't currently eligible for dispatch (no agent assignee, wrong
 * status), matching the conflict semantics of the legacy monitor run-now.
 */
export async function runIssueScheduledCheckNow(
  db: Db,
  deps: { wakeup: WakeupFn; logActivity: LogActivityFn },
  params: { issueId: string; checkId: string },
  now: Date = new Date(),
): Promise<IssueScheduledCheckRunNowResponse> {
  const [row] = await db
    .select()
    .from(issueScheduledChecks)
    .where(
      and(
        eq(issueScheduledChecks.id, params.checkId),
        eq(issueScheduledChecks.issueId, params.issueId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Scheduled check not found");
  if (row.status !== "scheduled") {
    throw conflict("Scheduled check is not pending");
  }

  const [issue] = await db
    .select({
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      status: issues.status,
    })
    .from(issues)
    .where(eq(issues.id, params.issueId))
    .limit(1);

  if (
    !issue ||
    !issue.assigneeAgentId ||
    issue.assigneeUserId ||
    !["in_progress", "in_review"].includes(issue.status)
  ) {
    const [current] = await db
      .select()
      .from(issueScheduledChecks)
      .where(eq(issueScheduledChecks.id, params.checkId))
      .limit(1);
    return {
      outcome: "skipped",
      reason: "Issue is not eligible for a scheduled check run right now",
      scheduledCheck: toApi(current ?? row),
    };
  }

  await dispatchIssueScheduledCheckRows(db, deps, params.issueId, [row], now);
  const [updated] = await db
    .select()
    .from(issueScheduledChecks)
    .where(eq(issueScheduledChecks.id, params.checkId))
    .limit(1);
  return { outcome: "triggered", scheduledCheck: toApi(updated ?? row) };
}

/**
 * Cancel any not-yet-fired scheduled rows with `cancel_on_comment: true` for
 * an issue. Hook this in wherever a human/board comment lands on the issue
 * (TOM-413 "good extra").
 */
export async function cancelScheduledChecksOnComment(
  db: Db,
  params: { issueId: string },
): Promise<number> {
  const result = await db
    .update(issueScheduledChecks)
    .set({
      status: "cancelled",
      cancelledAt: new Date(),
      cancelReason: "cancel_on_comment",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(issueScheduledChecks.issueId, params.issueId),
        eq(issueScheduledChecks.status, "scheduled"),
        eq(issueScheduledChecks.cancelOnComment, true),
      ),
    )
    .returning({ id: issueScheduledChecks.id });
  return result.length;
}
