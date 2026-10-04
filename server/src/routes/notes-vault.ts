import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { notesVaultWriteSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import {
  assertNotesVaultAccess,
  assertNotesVaultWriteAllowed,
  notesVaultAccessFor,
  notesVaultBridgeClient,
  notesVaultStatus,
  readNotesVaultConfig,
  type NotesVaultConfig,
} from "../services/notes-vault.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function notesVaultRoutes(
  db: Db,
  options: { config?: NotesVaultConfig | null; fetchImpl?: typeof fetch } = {},
) {
  const router = Router();
  const config = options.config === undefined ? readNotesVaultConfig() : options.config;
  const bridge = config ? notesVaultBridgeClient(config, options.fetchImpl) : null;

  function accessFor(req: Parameters<typeof assertCompanyAccess>[0], companyId: string) {
    assertCompanyAccess(req, companyId);
    return notesVaultAccessFor(config, companyId, { type: req.actor.type, agentId: req.actor.agentId ?? null });
  }

  function queryPath(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  router.get("/companies/:companyId/notes-vault", async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json(notesVaultStatus(config, accessFor(req, companyId)));
  });

  router.get("/companies/:companyId/notes-vault/list", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertNotesVaultAccess(accessFor(req, companyId), "read");
    res.json(await bridge!.list(queryPath(req.query.path)));
  });

  router.get("/companies/:companyId/notes-vault/file", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertNotesVaultAccess(accessFor(req, companyId), "read");
    res.json(await bridge!.read(queryPath(req.query.path)));
  });

  router.post("/companies/:companyId/notes-vault/file", validate(notesVaultWriteSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const access = accessFor(req, companyId);
    assertNotesVaultAccess(access, "write");
    const actorInfo = getActorInfo(req);
    const actor = { type: req.actor.type, agentId: req.actor.agentId ?? null };
    assertNotesVaultWriteAllowed(config!, req.body, actor);

    let actorLabel = "Board (Paperclip)";
    if (actor.type === "agent" && actor.agentId) {
      const agent = await db
        .select({ name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, actor.agentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      actorLabel = `${agent?.name ?? "Agent"} (Paperclip)`;
    }

    const result = await bridge!.write(req.body, actorLabel);
    await logActivity(db, {
      companyId,
      actorType: actorInfo.actorType,
      actorId: actorInfo.actorId,
      agentId: actorInfo.agentId,
      runId: actorInfo.runId,
      agentApiKeyId: actorInfo.agentApiKeyId,
      action: "notes_vault.file_written",
      entityType: "notes_vault_file",
      entityId: result.path,
      details: {
        path: result.path,
        mode: result.mode,
        summary: req.body.summary,
        sha256: result.sha256,
        previousSha256: result.previousSha256,
        bytes: result.bytes,
      },
    });
    res.json(result);
  });

  return router;
}
