import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRunEvents, heartbeatRuns, issues, lines } from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { builtInAgentService } from "./built-in-agents.js";
import { issueService } from "./issues.js";
import { lineService, lockLineTree, type LineActor } from "./lines.js";
import { logActivity } from "./activity-log.js";
import { lineNamingPrompt, sanitizeLineName } from "./line-naming-prompt.js";

const MODEL = "claude-haiku-4-5";
const MAX_AUTOMATIC_ATTEMPTS = 3;
const TIMEOUT_MS = 15 * 60_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function attribution(actor: LineActor) {
  return { actorType: actor.type, actorId: actor.agentId ?? actor.userId ?? "line_naming", agentId: actor.agentId ?? null, runId: actor.runId ?? null } as const;
}

// Restricted built-in agent that names Lines: claude_local, claude-haiku-4-5,
// no tools/credentials/workspace access. It self-provisions on first use so
// naming never depends on the enableBuiltInAgents switch or a board
// action — see TOM-707.
const LINE_NAMER_KEY = "line-namer";

export function lineNamingService(db: Db) {
  const lineSvc = lineService(db);
  const issuesSvc = issueService(db);
  const builtIns = builtInAgentService(db);

  async function ensureNamingAgent(companyId: string) {
    const existing = await builtIns.get(companyId, LINE_NAMER_KEY);
    // A row deliberately held (`paused`, `pending_approval`) is left
    // untouched regardless of its adapter.
    if (existing.status === "paused" || existing.status === "pending_approval") return existing;
    // `ready` only means `hasCompleteAdapterConfig()` found a non-empty model
    // string — it never checks the adapter type itself. A row left on an
    // adapter the current definition no longer allows (e.g. still
    // `codex_local` with its old model string, from before the
    // OpenAI-to-Claude swap in TOM-707) still reads `ready` and would
    // otherwise never reach ensure(). Treat that case the same as
    // `needs_setup`/`not_provisioned`: fall through to ensure().
    const adapterAllowed = !existing.agent
      || !existing.definition.allowedAdapterTypes
      || existing.definition.allowedAdapterTypes.includes(existing.agent.adapterType);
    if (existing.status === "ready" && adapterAllowed) return existing;
    try {
      // ensure() preserves any already-"complete" adapter config untouched
      // when called with no input, so a mismatched adapter type must be
      // overridden explicitly to force the migration.
      return await builtIns.ensure(
        companyId,
        LINE_NAMER_KEY,
        adapterAllowed ? undefined : {
          adapterType: existing.definition.defaultAdapterType,
          adapterConfig: existing.definition.defaultAdapterConfig,
        },
      );
    } catch {
      // Provisioning failed (e.g. the model is not yet in the adapter's
      // catalog). Leave the Line on its actionable error code; reconcile()
      // retries once the built-in agent becomes ready.
      return existing;
    }
  }

  async function markFailure(companyId: string, lineId: string, version: number, errorCode: string, actor: LineActor, allowReady = false) {
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(lines).where(and(eq(lines.companyId, companyId), eq(lines.id, lineId))).for("update");
      if (!row || row.namingVersion !== version || (row.namingStatus === "ready" && !allowReady) ||
          (row.namingStatus === "failed" && (!allowReady || row.lastNamingErrorCode === errorCode))) return;
      const [startedRun] = row.namingIssueId ? await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${row.namingIssueId}`,
          sql`${heartbeatRuns.startedAt} is not null`)).limit(1) : [];
      const attempts = row.namingAttempts + (startedRun && row.namingStatus === "generating" ? 1 : 0);
      const backoffMs = Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
      await tx.update(lines).set({ namingStatus: "failed", lastNamingErrorCode: errorCode,
        namingAttempts: attempts,
        nextNamingAttemptAt: startedRun && row.namingStatus === "generating" && attempts < MAX_AUTOMATIC_ATTEMPTS ? new Date(Date.now() + backoffMs) : null,
        updatedAt: new Date() }).where(eq(lines.id, lineId));
      await logActivity(tx as unknown as Db, { companyId, ...attribution(actor), action: "line.naming_failed", entityType: "line", entityId: lineId, details: { namingVersion: version, errorCode } });
    });
  }

  async function start(companyId: string, lineId: string, actor: LineActor, manual = false) {
    const [current] = await db.select().from(lines).where(and(eq(lines.companyId, companyId), eq(lines.id, lineId)));
    if (!current) throw notFound("Line not found");
    if (current.namingStatus === "generating") return { queued: false, namingIssueId: current.namingIssueId, failureCode: null };
    const builtIn = await ensureNamingAgent(companyId);
    if (builtIn.status !== "ready" || !builtIn.agentId) {
      const [row] = await db.select().from(lines).where(and(eq(lines.companyId, companyId), eq(lines.id, lineId)));
      if (!row) throw notFound("Line not found");
      await markFailure(companyId, lineId, row.namingVersion, "summarizer_not_configured", actor, manual);
      return { queued: false, namingIssueId: null, failureCode: "summarizer_not_configured" };
    }
    const [namer] = await db.select({ adapterType: agents.adapterType }).from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, builtIn.agentId)));
    if (!namer || namer.adapterType !== "claude_local") {
      await markFailure(companyId, lineId, current.namingVersion, "claude_override_unavailable", actor, manual);
      return { queued: false, namingIssueId: null, failureCode: "claude_override_unavailable" };
    }
    const result = await db.transaction(async (tx) => {
      await lockLineTree(tx, companyId);
      const [row] = await tx.select().from(lines).where(and(eq(lines.companyId, companyId), eq(lines.id, lineId))).for("update");
      if (!row) throw notFound("Line not found");
      if (row.namingStatus === "generating") return { queued: false, namingIssueId: row.namingIssueId, failureCode: null };
      if (!manual && (row.namingStatus === "ready" || row.namingAttempts >= MAX_AUTOMATIC_ATTEMPTS || (row.nextNamingAttemptAt && row.nextNamingAttemptAt > new Date())))
        return { queued: false, namingIssueId: row.namingIssueId, failureCode: null };
      if (row.namingIssueId) {
        const [activeRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${row.namingIssueId}`, sql`${heartbeatRuns.status} in ('queued', 'running')`)).limit(1);
        if (activeRun) return { queued: false, namingIssueId: row.namingIssueId, failureCode: null };
        await tx.update(issues).set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
          .where(and(eq(issues.companyId, companyId), eq(issues.id, row.namingIssueId), sql`${issues.status} not in ('done', 'cancelled')`));
      }
      const [root] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, row.rootIssueId)));
      if (!root) throw notFound("Line root not found");
      const version = row.namingVersion + 1;
      const created = await issuesSvc.create(companyId, {
        title: `Name Line ${root.identifier ?? root.id} (generation ${version})`,
        description: "Name this Line using the bounded root context in this task.",
        parentId: root.id, projectId: root.projectId,
        originKind: "line_naming", originId: lineId,
        status: "todo", priority: "low", hiddenAt: new Date(),
        assigneeAgentId: builtIn.agentId,
        assigneeAdapterOverrides: { adapterType: "claude_local", adapterConfig: { model: MODEL } },
        createdByAgentId: actor.agentId ?? null, createdByUserId: actor.userId ?? null,
        actorRunId: actor.runId ?? null,
      }, tx);
      await tx.update(issues).set({ description: lineNamingPrompt(lineId, version, root, created.id) })
        .where(and(eq(issues.companyId, companyId), eq(issues.id, created.id)));
      await tx.update(lines).set({ namingStatus: "generating", namingVersion: version,
        namingAttempts: row.namingAttempts, namingIssueId: created.id, nextNamingAttemptAt: null,
        lastNamingErrorCode: null, updatedAt: new Date() })
        .where(and(eq(lines.companyId, companyId), eq(lines.id, lineId)));
      await logActivity(tx as unknown as Db, { companyId, ...attribution(actor), action: "line.naming_started", entityType: "line", entityId: lineId, details: { namingVersion: version, namingIssueId: created.id, supersededNamingIssueId: row.namingIssueId, model: MODEL } });
      return { queued: true, namingIssueId: created.id, failureCode: null };
    });
    return result;
  }

  async function result(companyId: string, lineId: string, input: { namingVersion: number; namingIssueId: string; runId: string; name: unknown }, actor: LineActor) {
    if (actor.type !== "agent" || !actor.agentId || actor.runId !== input.runId) throw forbidden("Authenticated naming run required");
    const agentId = actor.agentId;
    const output = await db.transaction(async (tx) => {
      const [line] = await tx.select().from(lines).where(and(eq(lines.companyId, companyId), eq(lines.id, lineId))).for("update");
      if (!line) throw notFound("Line not found");
      if (line.namingStatus === "ready" && line.namingVersion === input.namingVersion && line.namingIssueId === input.namingIssueId && line.namingRunId === input.runId && line.name === sanitizeLineName(input.name)) return { row: line, invalid: false };
      if (line.namingStatus !== "generating" || line.namingVersion !== input.namingVersion || line.namingIssueId !== input.namingIssueId)
        throw conflict("Stale Line naming result");
      const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, input.namingIssueId), eq(issues.lineId, lineId)));
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.agentId, agentId)));
      const dispatch = record(run?.contextSnapshot);
      const override = record(task?.assigneeAdapterOverrides);
      const config = record(override.adapterConfig);
      const usage = record(run?.usageJson);
      const providerMessages = run ? await tx.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload, sourceEventId: heartbeatRunEvents.sourceEventId })
        .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, run.id),
          inArray(heartbeatRunEvents.eventType, ["item.completed", "line.naming.provider_message"]))) : [];
      const name = sanitizeLineName(input.name);
      const submittedName = typeof input.name === "string" ? input.name.trim() : null;
      const observedName = submittedName !== null && providerMessages.some((event) => {
        if (event.eventType === "line.naming.provider_message")
          return record(event.payload).textSha256 === createHash("sha256").update(submittedName).digest("hex");
        if (!event.sourceEventId) return false;
        const providerEvent = record(record(event.payload).prpEvent);
        const message = record(providerEvent.payload);
        return (message.kind === "agentMessage" || message.kind === "assistant_message") &&
          typeof message.text === "string" && message.text.trim() === submittedName;
      });
      const resolvedAdapter = dispatch.lineNamingResolvedAdapterType;
      if (!task || task.originKind !== "line_naming" || task.originId !== lineId || task.assigneeAgentId !== agentId || !run || run.status !== "running" || run.finishedAt || dispatch.issueId !== task.id || !run.startedAt ||
          (task.checkoutRunId !== run.id && task.executionRunId !== run.id) ||
          resolvedAdapter !== "claude_local" || dispatch.lineNamingResolvedModel !== MODEL || override.adapterType !== "claude_local" || config.model !== MODEL ||
          (usage.provider !== undefined && usage.provider !== "anthropic") || (usage.model !== undefined && usage.model !== MODEL) || !observedName)
        throw forbidden("Verified Claude naming provenance required");
      if (!name) {
        const attempts = line.namingAttempts + 1;
        const [failed] = await tx.update(lines).set({ namingStatus: "failed", namingAttempts: attempts, lastNamingErrorCode: "invalid_output", nextNamingAttemptAt: attempts < MAX_AUTOMATIC_ATTEMPTS ? new Date(Date.now() + 60_000 * 2 ** Math.max(0, attempts - 1)) : null, updatedAt: new Date() })
          .where(and(eq(lines.companyId, companyId), eq(lines.id, lineId))).returning();
        await logActivity(tx as unknown as Db, { companyId, ...attribution(actor), action: "line.naming_failed", entityType: "line", entityId: lineId, details: { namingVersion: input.namingVersion, errorCode: "invalid_output" } });
        return { row: failed, invalid: true };
      }
      const [updated] = await tx.update(lines).set({ name, namingStatus: "ready", namingAttempts: line.namingAttempts + 1, namingModel: MODEL, namingRunId: run.id,
        namedAt: new Date(), nextNamingAttemptAt: null, lastNamingErrorCode: null, updatedAt: new Date() })
        .where(and(eq(lines.companyId, companyId), eq(lines.id, lineId), eq(lines.namingVersion, input.namingVersion))).returning();
      await logActivity(tx as unknown as Db, { companyId, ...attribution(actor), action: "line.named", entityType: "line", entityId: lineId, details: { namingVersion: input.namingVersion, model: MODEL, namingIssueId: task.id } });
      return { row: updated, invalid: false };
    });
    if (output.invalid) throw unprocessable("Invalid Line name");
    const line = await lineSvc.get(companyId, output.row.id);
    if (!line) throw notFound("Line not found");
    return line;
  }

  async function reconcile(onQueued?: (companyId: string, issueId: string) => Promise<void>) {
    const due = await db.select().from(lines).where(
      inArray(lines.namingStatus, ["pending", "failed", "generating"]));
    for (const row of due) {
      if (row.namingStatus === "generating") {
        const [task] = row.namingIssueId ? await db.select({ status: issues.status }).from(issues).where(and(eq(issues.companyId, row.companyId), eq(issues.id, row.namingIssueId))) : [];
        const [run] = row.namingIssueId ? await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt }).from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, row.companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${row.namingIssueId}`))
          .orderBy(sql`${heartbeatRuns.createdAt} desc`).limit(1) : [];
        if (!task || task.status === "done" || task.status === "cancelled" ||
            (run?.startedAt && run.startedAt.getTime() + TIMEOUT_MS < Date.now()) ||
            (run && run.status !== "queued" && run.status !== "running"))
          await markFailure(row.companyId, row.id, row.namingVersion, "naming_timeout_or_task_finished", { type: "system" });
        else if (onQueued && row.namingIssueId) {
          if (!run?.startedAt && row.lastNamingErrorCode !== "waiting_for_dispatch")
            await db.update(lines).set({ lastNamingErrorCode: "waiting_for_dispatch", updatedAt: new Date() })
              .where(and(eq(lines.companyId, row.companyId), eq(lines.id, row.id), eq(lines.namingVersion, row.namingVersion)));
          if (run?.startedAt && row.lastNamingErrorCode === "waiting_for_dispatch")
            await db.update(lines).set({ lastNamingErrorCode: null, updatedAt: new Date() })
              .where(and(eq(lines.companyId, row.companyId), eq(lines.id, row.id), eq(lines.namingVersion, row.namingVersion)));
          if (!run) await onQueued(row.companyId, row.namingIssueId);
        }
      } else if (row.namingStatus === "pending" || (row.nextNamingAttemptAt && row.nextNamingAttemptAt <= new Date()) ||
          (row.namingStatus === "failed" && row.lastNamingErrorCode === "summarizer_not_configured" &&
            (await ensureNamingAgent(row.companyId)).status === "ready")) {
        try {
          const generation = await start(row.companyId, row.id, { type: "system" });
          if (generation.queued && generation.namingIssueId && onQueued) await onQueued(row.companyId, generation.namingIssueId);
        } catch {
          await markFailure(row.companyId, row.id, row.namingVersion, "naming_setup_failed", { type: "system" });
        }
      }
    }
  }

  return { start, result, markFailure, reconcile };
}
