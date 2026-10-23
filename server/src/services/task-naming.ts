import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues, issueTitleNamings } from "@paperclipai/db";
import { deriveIssueStepKey } from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { issueService } from "./issues.js";
import { ensureLineNamerAgent } from "./line-naming.js";
import type { LineActor } from "./lines.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { sanitizeTaskTitle, shouldNameTask, taskNamingPrompt } from "./task-naming-prompt.js";
import { verifiedNamingRun } from "./naming-run-provenance.js";

const MODEL = "claude-haiku-4-5";
const MAX_AUTOMATIC_ATTEMPTS = 3;
const TIMEOUT_MS = 15 * 60_000;
// The hidden task's origin fingerprint marks a board-requested generation,
// which may rename a task whose title is not (or no longer) derived.
const MANUAL_FINGERPRINT = "manual";

export type TaskNamingActor = LineActor;

type NamingRow = typeof issueTitleNamings.$inferSelect;

function attribution(actor: TaskNamingActor) {
  return { actorType: actor.type, actorId: actor.agentId ?? actor.userId ?? "task_naming", agentId: actor.agentId ?? null, runId: actor.runId ?? null } as const;
}

/** Backoff after the n-th failed attempt: 1, 2, then 4 minutes. */
function backoffMs(attempts: number) {
  return 60_000 * 2 ** Math.max(0, attempts - 1);
}

export function taskNamingService(db: Db) {
  const issuesSvc = issueService(db);

  async function startedInLastHour(companyId: string, dbOrTx: any = db) {
    const [row] = await dbOrTx.select({ count: sql<number>`count(*)::int` }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_naming"),
        gt(issues.createdAt, new Date(Date.now() - 60 * 60_000))));
    return Number(row?.count ?? 0);
  }

  async function ensureRow(companyId: string, issueId: string) {
    await db.insert(issueTitleNamings).values({ companyId, issueId }).onConflictDoNothing();
  }

  async function markSkipped(companyId: string, issueId: string, errorCode: string, actor: TaskNamingActor) {
    await ensureRow(companyId, issueId);
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(issueTitleNamings)
        .where(and(eq(issueTitleNamings.companyId, companyId), eq(issueTitleNamings.issueId, issueId))).for("update");
      if (!row || row.status === "generating" || row.status === "ready" || row.status === "skipped") return;
      await tx.update(issueTitleNamings).set({ status: "skipped", lastErrorCode: errorCode, nextAttemptAt: null, updatedAt: new Date() })
        .where(and(eq(issueTitleNamings.companyId, companyId), eq(issueTitleNamings.id, row.id)));
      await logActivity(tx as unknown as Db, { companyId, ...attribution(actor), action: "issue.title_naming_skipped", entityType: "issue", entityId: issueId, details: { errorCode } });
    });
  }

  async function markFailure(companyId: string, issueId: string, version: number, errorCode: string, actor: TaskNamingActor, allowReady = false) {
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(issueTitleNamings)
        .where(and(eq(issueTitleNamings.companyId, companyId), eq(issueTitleNamings.issueId, issueId))).for("update");
      if (!row || row.namingVersion !== version || row.status === "skipped" || (row.status === "ready" && !allowReady) ||
          (row.status === "failed" && (!allowReady || row.lastErrorCode === errorCode))) return;
      const [startedRun] = row.namingIssueId ? await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${row.namingIssueId}`,
          sql`${heartbeatRuns.startedAt} is not null`)).limit(1) : [];
      const counted = !!startedRun && row.status === "generating";
      const attempts = row.attempts + (counted ? 1 : 0);
      await tx.update(issueTitleNamings).set({ status: "failed", lastErrorCode: errorCode, attempts,
        nextAttemptAt: counted && attempts < MAX_AUTOMATIC_ATTEMPTS ? new Date(Date.now() + backoffMs(attempts)) : null,
        updatedAt: new Date() })
        .where(and(eq(issueTitleNamings.companyId, companyId), eq(issueTitleNamings.id, row.id)));
      await logActivity(tx as unknown as Db, { companyId, ...attribution(actor), action: "issue.title_naming_failed", entityType: "issue", entityId: issueId, details: { namingVersion: version, errorCode } });
    });
  }

  /**
   * Starts one naming generation. Automatic starts (`manual` false) apply the
   * eligibility rules and the retry budget; a board retry (`manual` true)
   * names any visible, non-naming task, whatever its title source.
   */
  async function start(companyId: string, issueId: string, actor: TaskNamingActor, manual = false) {
    const [target] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    if (!target) throw notFound("Issue not found");
    const idle = { queued: false as const, namingIssueId: null as string | null, failureCode: null as string | null };
    const [existing] = await db.select().from(issueTitleNamings)
      .where(and(eq(issueTitleNamings.companyId, companyId), eq(issueTitleNamings.issueId, issueId)));
    if (existing?.status === "generating") return { ...idle, namingIssueId: existing.namingIssueId };
    const decision = shouldNameTask(manual ? { ...target, titleSource: "derived", description: "manual retry of an existing task" } : target,
      manual || existing ? 0 : await startedInLastHour(companyId));
    if (!decision.name) {
      if (manual) throw unprocessable("This task cannot be named");
      // Too short or rate limited is recorded; an ineligible task gets no row,
      // but a row left from an earlier generation is closed.
      if (decision.reason === "too_short" || decision.reason === "rate_limited" || existing) {
        await markSkipped(companyId, issueId, decision.reason === "not_derived" ? "title_changed" : decision.reason, actor);
        return { ...idle, failureCode: decision.reason };
      }
      return idle;
    }
    await ensureRow(companyId, issueId);
    const builtIn = await ensureLineNamerAgent(db, companyId);
    if (builtIn.status !== "ready" || !builtIn.agentId) {
      const [row] = await db.select().from(issueTitleNamings).where(and(eq(issueTitleNamings.companyId, companyId), eq(issueTitleNamings.issueId, issueId)));
      await markFailure(companyId, issueId, row!.namingVersion, "summarizer_not_configured", actor, manual);
      return { ...idle, failureCode: "summarizer_not_configured" };
    }
    const [namer] = await db.select({ adapterType: agents.adapterType }).from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, builtIn.agentId)));
    if (!namer || namer.adapterType !== "claude_local") {
      const [row] = await db.select().from(issueTitleNamings).where(and(eq(issueTitleNamings.companyId, companyId), eq(issueTitleNamings.issueId, issueId)));
      await markFailure(companyId, issueId, row!.namingVersion, "claude_override_unavailable", actor, manual);
      return { ...idle, failureCode: "claude_override_unavailable" };
    }
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(issueTitleNamings)
        .where(and(eq(issueTitleNamings.companyId, companyId), eq(issueTitleNamings.issueId, issueId))).for("update");
      if (!row) throw notFound("Issue not found");
      if (row.status === "generating") return { ...idle, namingIssueId: row.namingIssueId };
      if (!manual && (row.status === "ready" || row.status === "skipped" || row.attempts >= MAX_AUTOMATIC_ATTEMPTS ||
          (row.nextAttemptAt && row.nextAttemptAt > new Date())))
        return { ...idle, namingIssueId: row.namingIssueId };
      const [current] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).for("update");
      if (!current) throw notFound("Issue not found");
      if (!manual && current.titleSource !== "derived") {
        await tx.update(issueTitleNamings).set({ status: "skipped", lastErrorCode: "title_changed", nextAttemptAt: null, updatedAt: new Date() })
          .where(and(eq(issueTitleNamings.companyId, companyId), eq(issueTitleNamings.id, row.id)));
        return { ...idle, failureCode: "title_changed" };
      }
      if (row.namingIssueId) {
        const [activeRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${row.namingIssueId}`, sql`${heartbeatRuns.status} in ('queued', 'running')`)).limit(1);
        if (activeRun) return { ...idle, namingIssueId: row.namingIssueId };
        await tx.update(issues).set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
          .where(and(eq(issues.companyId, companyId), eq(issues.id, row.namingIssueId), sql`${issues.status} not in ('done', 'cancelled')`));
      }
      const version = row.namingVersion + 1;
      const created = await issuesSvc.create(companyId, {
        title: `Name task ${current.identifier ?? current.id} (generation ${version})`,
        description: "Name this task using the bounded context in this task.",
        parentId: null, projectId: current.projectId,
        originKind: "task_naming", originId: issueId,
        originFingerprint: manual ? MANUAL_FINGERPRINT : "default",
        titleSource: "explicit",
        status: "todo", priority: "low", hiddenAt: new Date(),
        assigneeAgentId: builtIn.agentId,
        assigneeAdapterOverrides: { adapterType: "claude_local", adapterConfig: { model: MODEL } },
        createdByAgentId: actor.agentId ?? null, createdByUserId: actor.userId ?? null,
        actorRunId: actor.runId ?? null,
        allowDuplicate: true,
      }, tx);
      await tx.update(issues).set({ description: taskNamingPrompt(issueId, version, current, created.id) })
        .where(and(eq(issues.companyId, companyId), eq(issues.id, created.id)));
      await tx.update(issueTitleNamings).set({ status: "generating", namingVersion: version, namingIssueId: created.id,
        titleAtStart: current.title, model: MODEL, nextAttemptAt: null, lastErrorCode: null, updatedAt: new Date() })
        .where(and(eq(issueTitleNamings.companyId, companyId), eq(issueTitleNamings.id, row.id)));
      await logActivity(tx as unknown as Db, { companyId, ...attribution(actor), action: "issue.title_naming_started", entityType: "issue", entityId: issueId,
        details: { namingVersion: version, namingIssueId: created.id, supersededNamingIssueId: row.namingIssueId, model: MODEL, manual } });
      return { queued: true as const, namingIssueId: created.id as string | null, failureCode: null as string | null };
    });
  }

  async function result(companyId: string, issueId: string, input: { namingVersion: number; namingIssueId: string; runId: string; title: unknown }, actor: TaskNamingActor) {
    if (actor.type !== "agent" || !actor.agentId || actor.runId !== input.runId) throw forbidden("Authenticated naming run required");
    const agentId = actor.agentId;
    const publications: ActivityPublication[] = [];
    const output = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(issueTitleNamings)
        .where(and(eq(issueTitleNamings.companyId, companyId), eq(issueTitleNamings.issueId, issueId))).for("update");
      if (!row) throw notFound("Issue not found");
      const [target] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).for("update");
      if (!target) throw notFound("Issue not found");
      const title = sanitizeTaskTitle(input.title);
      if (row.status === "ready" && row.namingVersion === input.namingVersion && row.namingIssueId === input.namingIssueId &&
          row.namingRunId === input.runId && title !== null && target.title === title) return { kind: "ok" as const };
      if (row.status !== "generating" || row.namingVersion !== input.namingVersion || row.namingIssueId !== input.namingIssueId)
        throw conflict("Stale task naming result");
      const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, input.namingIssueId)));
      const run = await verifiedNamingRun(tx, { companyId, agentId, runId: input.runId, task, originKind: "task_naming", originId: issueId, submitted: input.title, model: MODEL });
      if (!task || !run) throw forbidden("Verified Claude naming provenance required");
      if (!title) {
        const attempts = row.attempts + 1;
        await tx.update(issueTitleNamings).set({ status: "failed", attempts, lastErrorCode: "invalid_output",
          nextAttemptAt: attempts < MAX_AUTOMATIC_ATTEMPTS ? new Date(Date.now() + backoffMs(attempts)) : null, updatedAt: new Date() })
          .where(and(eq(issueTitleNamings.companyId, companyId), eq(issueTitleNamings.id, row.id)));
        await logActivity(tx as unknown as Db, { companyId, ...attribution(actor), action: "issue.title_naming_failed", entityType: "issue", entityId: issueId, details: { namingVersion: input.namingVersion, errorCode: "invalid_output" } });
        return { kind: "invalid" as const };
      }
      const manual = task.originFingerprint === MANUAL_FINGERPRINT;
      if (target.title !== row.titleAtStart || (target.titleSource !== "derived" && !manual)) {
        await tx.update(issueTitleNamings).set({ status: "skipped", lastErrorCode: "title_changed", nextAttemptAt: null, updatedAt: new Date() })
          .where(and(eq(issueTitleNamings.companyId, companyId), eq(issueTitleNamings.id, row.id)));
        await logActivity(tx as unknown as Db, { companyId, ...attribution(actor), action: "issue.title_naming_skipped", entityType: "issue", entityId: issueId, details: { namingVersion: input.namingVersion, errorCode: "title_changed" } });
        return { kind: "title_changed" as const };
      }
      const nextStepKey = deriveIssueStepKey(target.parentId, title);
      await tx.update(issues).set({ title, titleSource: "ai", ...(nextStepKey !== target.stepKey ? { stepKey: nextStepKey } : {}), updatedAt: new Date() })
        .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
      await tx.update(issueTitleNamings).set({ status: "ready", attempts: row.attempts + 1, model: MODEL, namingRunId: run.id,
        namedAt: new Date(), nextAttemptAt: null, lastErrorCode: null, updatedAt: new Date() })
        .where(and(eq(issueTitleNamings.companyId, companyId), eq(issueTitleNamings.id, row.id), eq(issueTitleNamings.namingVersion, input.namingVersion)));
      const by = { companyId, actorType: "agent" as const, actorId: agentId, agentId, runId: run.id, entityType: "issue", entityId: issueId };
      await logActivity(tx as unknown as Db, { ...by, action: "issue.title_named",
        details: { fromTitle: target.title, toTitle: title, model: MODEL, namingIssueId: task.id } }, publications);
      // The ordinary update event, so open board pages refresh the title.
      await logActivity(tx as unknown as Db, { ...by, action: "issue.updated",
        details: { identifier: target.identifier, title, titleSource: "ai", source: "task_naming", _previous: { title: target.title } } }, publications);
      return { kind: "ok" as const };
    });
    for (const publication of publications) publishActivity(publication);
    if (output.kind === "invalid") throw unprocessable("Invalid task title");
    if (output.kind === "title_changed") throw conflict("The task title changed after naming started");
    const issue = await issuesSvc.getById(issueId);
    if (!issue || issue.companyId !== companyId) throw notFound("Issue not found");
    return issue;
  }

  async function reconcile(onQueued?: (companyId: string, issueId: string) => Promise<void>) {
    const due: NamingRow[] = await db.select().from(issueTitleNamings).where(or(
      inArray(issueTitleNamings.status, ["pending", "generating"]),
      and(eq(issueTitleNamings.status, "failed"), sql`${issueTitleNamings.nextAttemptAt} is not null`),
      and(eq(issueTitleNamings.status, "failed"), eq(issueTitleNamings.lastErrorCode, "summarizer_not_configured"))));
    for (const row of due) {
      if (row.status === "generating") {
        const [task] = row.namingIssueId ? await db.select({ status: issues.status }).from(issues).where(and(eq(issues.companyId, row.companyId), eq(issues.id, row.namingIssueId))) : [];
        const [run] = row.namingIssueId ? await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt }).from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, row.companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${row.namingIssueId}`))
          .orderBy(sql`${heartbeatRuns.createdAt} desc`).limit(1) : [];
        if (!task || task.status === "done" || task.status === "cancelled" ||
            (run?.startedAt && run.startedAt.getTime() + TIMEOUT_MS < Date.now()) ||
            (run && run.status !== "queued" && run.status !== "running"))
          await markFailure(row.companyId, row.issueId, row.namingVersion, "naming_timeout_or_task_finished", { type: "system" });
        else if (onQueued && row.namingIssueId && !run) await onQueued(row.companyId, row.namingIssueId);
      } else if (row.status === "pending" || (row.nextAttemptAt && row.nextAttemptAt <= new Date()) ||
          (row.status === "failed" && row.lastErrorCode === "summarizer_not_configured" &&
            (await ensureLineNamerAgent(db, row.companyId)).status === "ready")) {
        try {
          const generation = await start(row.companyId, row.issueId, { type: "system" });
          if (generation.queued && generation.namingIssueId && onQueued) await onQueued(row.companyId, generation.namingIssueId);
        } catch {
          await markFailure(row.companyId, row.issueId, row.namingVersion, "naming_setup_failed", { type: "system" });
        }
      }
    }
  }

  return { start, result, markFailure, reconcile, startedInLastHour };
}
