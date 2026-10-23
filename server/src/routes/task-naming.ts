import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { issueTitleNamingResultSchema, retryIssueTitleNamingSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { taskNamingService, type TaskNamingActor } from "../services/task-naming.js";
import { heartbeatService } from "../services/heartbeat.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { logActivity } from "../services/activity-log.js";
import { assertBoard, getAccessibleResource, getActorInfo } from "./authz.js";

/** Queues the Line Namer for a freshly started task naming generation. */
export async function wakeTaskNamer(db: Db, heartbeat: ReturnType<typeof heartbeatService>, companyId: string, namingIssueId: string,
  options: { reason: string; mutation: string; requestedByActorType: "agent" | "user" | "system"; requestedByActorId?: string | null }) {
  const [task] = await db.select({ assigneeAgentId: issues.assigneeAgentId, status: issues.status }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, namingIssueId)));
  if (!task) return;
  await queueIssueAssignmentWakeup({ heartbeat, issue: { id: namingIssueId, ...task }, reason: options.reason, mutation: options.mutation,
    contextSource: "task.naming", requestedByActorType: options.requestedByActorType, requestedByActorId: options.requestedByActorId ?? null,
    taskKey: `task-naming:${companyId}:${namingIssueId}` });
}

export function taskNamingRoutes(db: Db) {
  const router = Router();
  const naming = taskNamingService(db);
  const heartbeat = heartbeatService(db);
  const actorFor = (req: Parameters<typeof getActorInfo>[0]): TaskNamingActor => {
    const actor = getActorInfo(req);
    return { type: actor.actorType, agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null, runId: actor.runId };
  };

  router.post("/issues/:issueId/title-naming/retry", validate(retryIssueTitleNamingSchema), async (req, res) => {
    assertBoard(req);
    const [row] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, req.params.issueId as string));
    const accessible = await getAccessibleResource(req, res, row, "Issue not found");
    if (!accessible) return;
    const actor = actorFor(req);
    const issueId = req.params.issueId as string;
    const generation = await naming.start(accessible.companyId, issueId, actor, true);
    await logActivity(db, { companyId: accessible.companyId, actorType: "user", actorId: actor.userId ?? "board", agentId: null, runId: null,
      action: "issue.title_naming_retried", entityType: "issue", entityId: issueId,
      details: { namingIssueId: generation.namingIssueId, queued: generation.queued, failureCode: generation.failureCode } });
    if (generation.queued && generation.namingIssueId)
      await wakeTaskNamer(db, heartbeat, accessible.companyId, generation.namingIssueId,
        { reason: "task_naming_retry", mutation: "task.naming.retry", requestedByActorType: "user", requestedByActorId: actor.userId });
    res.status(202).json(generation);
  });

  router.post("/issues/:issueId/title-naming/result", validate(issueTitleNamingResultSchema), async (req, res) => {
    if (req.actor.type !== "agent" || req.actor.source !== "agent_jwt") throw forbidden("Naming result requires a run-bound agent token");
    const [row] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, req.params.issueId as string));
    const accessible = await getAccessibleResource(req, res, row, "Issue not found");
    if (!accessible) return;
    res.json(await naming.result(accessible.companyId, req.params.issueId as string, req.body, actorFor(req)));
  });
  return router;
}
