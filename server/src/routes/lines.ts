import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { issues, lines } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { createLineSchema, listLinesQuerySchema, updateLineSchema } from "@paperclipai/shared";
import { z } from "zod";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { lineService, type LineActor } from "../services/lines.js";
import { lineNamingService } from "../services/line-naming.js";
import { heartbeatService } from "../services/heartbeat.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { accessService } from "../services/access.js";
import { assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

export function lineRoutes(db: Db) {
  const router = Router();
  const svc = lineService(db);
  const naming = lineNamingService(db);
  const heartbeat = heartbeatService(db);
  const access = accessService(db);
  async function assertRootAccess(req: Parameters<typeof getActorInfo>[0], companyId: string, rootIssueId: string, action: "issue:read" | "issue:mutate") {
    const [root] = await db.select({ id: issues.id, companyId: issues.companyId, projectId: issues.projectId, parentId: issues.parentId, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId, status: issues.status }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, rootIssueId)));
    if (!root) throw notFound("Issue not found");
    if (req.actor.type === "agent") {
      const decision = await access.decide({ actor: req.actor, action,
        resource: { type: "issue", companyId, issueId: root.id, projectId: root.projectId, parentIssueId: root.parentId, assigneeAgentId: root.assigneeAgentId, assigneeUserId: root.assigneeUserId, status: root.status },
        scope: { issueId: root.id, projectId: root.projectId, parentIssueId: root.parentId, assigneeAgentId: root.assigneeAgentId, assigneeUserId: root.assigneeUserId } });
      if (!decision.allowed) throw forbidden("Line root is outside this actor's authorization boundary");
    }
    return root;
  }
  async function canReadLineMembers(req: Parameters<typeof getActorInfo>[0], companyId: string,
    root: typeof issues.$inferSelect, members: Array<typeof issues.$inferSelect>) {
    if (req.actor.type !== "agent") return true;
    if (members.some((member) => member.hiddenAt && member.originKind !== "line_naming")) return false;
    for (const member of [root, ...members.filter((item) => item.id !== root.id && !item.hiddenAt)]) {
      const decision = await access.decide({ actor: req.actor, action: "issue:read",
        resource: { type: "issue", companyId, issueId: member.id, projectId: member.projectId,
          parentIssueId: member.parentId, assigneeAgentId: member.assigneeAgentId,
          assigneeUserId: member.assigneeUserId, status: member.status },
        scope: { issueId: member.id, projectId: member.projectId, parentIssueId: member.parentId,
          assigneeAgentId: member.assigneeAgentId, assigneeUserId: member.assigneeUserId } });
      if (!decision.allowed) return false;
    }
    return true;
  }
  const actorFor = (req: Parameters<typeof getActorInfo>[0]): LineActor => {
    const actor = getActorInfo(req);
    return { type: actor.actorType, agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null, runId: actor.runId };
  };

  router.get("/companies/:companyId/lines", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = listLinesQuerySchema.parse(req.query);
    res.json(await svc.list(companyId, query, req.actor.type === "agent"
      ? (root, members) => canReadLineMembers(req, companyId, root, members)
      : undefined));
  });

  router.post("/companies/:companyId/lines", validate(createLineSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rootIssueId = req.body.rootIssueId as string;
    const root = await assertRootAccess(req, companyId, rootIssueId, "issue:mutate");
    if (req.actor.type === "agent" && root.assigneeAgentId !== req.actor.agentId)
      throw forbidden("Only the root assignee can start its Line");
    const result = await svc.ensure(companyId, rootIssueId, actorFor(req));
    if (result.created) {
      try {
        const generation = await naming.start(companyId, result.line.id, actorFor(req));
        if (generation.queued && generation.namingIssueId) {
          await queueIssueAssignmentWakeup({ heartbeat, issue: { id: generation.namingIssueId, assigneeAgentId: (await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, generation.namingIssueId)))[0]?.assigneeAgentId ?? null, status: "todo" }, reason: "line_naming_requested", mutation: "line.naming.start", contextSource: "line.naming", requestedByActorType: actorFor(req).type, requestedByActorId: actorFor(req).agentId ?? actorFor(req).userId ?? null, taskKey: `line-naming:${result.line.id}:${generation.namingIssueId}` });
        }
      } catch {
        await naming.markFailure(companyId, result.line.id, (await svc.get(companyId, result.line.id))!.namingVersion, "naming_setup_failed", actorFor(req));
      }
    }
    res.status(result.created ? 201 : 200).json((await svc.get(companyId, result.line.id)) ?? result.line);
  });

  router.get("/lines/:lineId", async (req, res) => {
    const [row] = await db.select({ companyId: lines.companyId }).from(lines).where(eq(lines.id, req.params.lineId as string));
    const accessible = await getAccessibleResource(req, res, row, "Line not found");
    if (!accessible) return;
    const [stored] = await db.select({ rootIssueId: lines.rootIssueId }).from(lines).where(and(eq(lines.companyId, accessible.companyId), eq(lines.id, req.params.lineId as string)));
    if (!stored) throw notFound("Line not found");
    await assertRootAccess(req, accessible.companyId, stored.rootIssueId, "issue:read");
    if (req.actor.type === "agent") {
      const [root] = await db.select().from(issues).where(and(eq(issues.companyId, accessible.companyId), eq(issues.id, stored.rootIssueId)));
      const members = await db.select().from(issues).where(and(eq(issues.companyId, accessible.companyId), eq(issues.lineId, req.params.lineId as string)));
      if (!root || !await canReadLineMembers(req, accessible.companyId, root, members)) throw forbidden("Line contains inaccessible work");
    }
    const line = await svc.get(accessible.companyId, req.params.lineId as string);
    if (!line) throw notFound("Line not found");
    res.json(req.actor.type === "agent" ? { ...line, pendingApprovals: [] } : line);
  });

  router.patch("/lines/:lineId", validate(updateLineSchema), async (req, res) => {
    const [row] = await db.select({ companyId: lines.companyId, rootIssueId: lines.rootIssueId }).from(lines)
      .where(eq(lines.id, req.params.lineId as string));
    const accessible = await getAccessibleResource(req, res, row, "Line not found");
    if (!accessible) return;
    await assertRootAccess(req, row.companyId, row.rootIssueId, "issue:mutate");
    if (req.actor.type === "agent") {
      const [root] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues)
        .where(and(eq(issues.companyId, row.companyId), eq(issues.id, row.rootIssueId)));
      if (root?.assigneeAgentId !== req.actor.agentId) throw forbidden("Only the root assignee can archive its Line");
    }
    res.json(await svc.archive(row.companyId, req.params.lineId as string, req.body.archived as boolean, actorFor(req)));
  });

  router.post("/lines/:lineId/naming/retry", validate(z.object({}).strict()), async (req, res) => {
    const [row] = await db.select({ companyId: lines.companyId, rootIssueId: lines.rootIssueId }).from(lines).where(eq(lines.id, req.params.lineId as string));
    const accessible = await getAccessibleResource(req, res, row, "Line not found");
    if (!accessible) return;
    await assertRootAccess(req, row.companyId, row.rootIssueId, "issue:mutate");
    if (req.actor.type === "agent") {
      const [root] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(and(eq(issues.companyId, row.companyId), eq(issues.id, row.rootIssueId)));
      if (root?.assigneeAgentId !== req.actor.agentId) throw forbidden("Only the root assignee can retry naming");
    }
    let generation;
    try { generation = await naming.start(row.companyId, req.params.lineId as string, actorFor(req), true); }
    catch {
      await naming.markFailure(row.companyId, req.params.lineId as string, (await svc.get(row.companyId, req.params.lineId as string))!.namingVersion, "naming_setup_failed", actorFor(req), true);
      res.status(202).json(await svc.get(row.companyId, req.params.lineId as string));
      return;
    }
    if (generation.queued && generation.namingIssueId) {
      const [task] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, generation.namingIssueId));
      await queueIssueAssignmentWakeup({ heartbeat, issue: { id: generation.namingIssueId, assigneeAgentId: task?.assigneeAgentId ?? null, status: "todo" }, reason: "line_naming_retry", mutation: "line.naming.retry", contextSource: "line.naming", requestedByActorType: actorFor(req).type, requestedByActorId: actorFor(req).agentId ?? actorFor(req).userId ?? null, taskKey: `line-naming:${row.companyId}:${generation.namingIssueId}` });
    }
    res.status(202).json(await svc.get(row.companyId, req.params.lineId as string));
  });

  router.post("/lines/:lineId/naming/result", validate(z.object({ namingVersion: z.number().int().nonnegative(), namingIssueId: z.string().uuid(), runId: z.string().uuid(), name: z.unknown() }).strict()), async (req, res) => {
    if (req.actor.type !== "agent" || req.actor.source !== "agent_jwt") throw forbidden("Naming result requires a run-bound agent token");
    const [row] = await db.select({ companyId: lines.companyId }).from(lines).where(eq(lines.id, req.params.lineId as string));
    const accessible = await getAccessibleResource(req, res, row, "Line not found");
    if (!accessible) return;
    res.json(await naming.result(row.companyId, req.params.lineId as string, req.body, actorFor(req)));
  });
  return router;
}
