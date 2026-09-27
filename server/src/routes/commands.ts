import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { commandExecuteRequestSchema, type CommandExecuteResponse } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { issueService, logActivity } from "../services/index.js";
import type { CommandDispatcher } from "../services/command-dispatcher.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function commandRoutes(db: Db, dispatcher: CommandDispatcher) {
  const router = Router();
  const issues = issueService(db);

  router.get("/companies/:companyId/commands", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await dispatcher.listCommands(companyId, "ui_chat"));
  });

  router.post("/companies/:companyId/commands/execute", async (req, res) => {
    const companyId = req.params.companyId as string;
    // POST: also enforces active, non-viewer membership for board users.
    assertCompanyAccess(req, companyId);
    const body = commandExecuteRequestSchema.parse(req.body);
    if (body.issueId) {
      const issue = await issues.getById(body.issueId);
      // Same 404 for missing and cross-company issues: no existence oracle.
      if (!issue || issue.companyId !== companyId) throw notFound("Issue not found");
    }
    const actor = getActorInfo(req);
    const outcome = await dispatcher.execute({
      command: body.command,
      args: body.args,
      context: {
        companyId,
        surface: "ui_chat",
        actor: { type: actor.actorType, id: actor.actorId },
        issueId: body.issueId ?? null,
      },
    });
    if (outcome.status === "not_found") throw notFound(`Unknown command /${body.command}`);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "command.executed",
      entityType: "command",
      entityId: outcome.command,
      issueId: body.issueId ?? null,
      // Arguments can contain user content; record only the outcome.
      details: { command: outcome.command, surface: "ui_chat", success: outcome.result.success },
    });
    const response: CommandExecuteResponse = { command: outcome.command, result: outcome.result };
    res.json(response);
  });

  return router;
}
