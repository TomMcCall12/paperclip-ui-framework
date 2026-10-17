import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { notesVaultWriteSchema } from "@paperclipai/shared";
import { badRequest } from "../errors.js";
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

  /**
   * Whether a file contains a string, without the bridge limit a full read is held to —
   * the cheap check for an idempotency marker in a file too large to read whole.
   */
  router.get("/companies/:companyId/notes-vault/contains", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertNotesVaultAccess(accessFor(req, companyId), "read");
    const needle = queryPath(req.query.needle);
    if (!needle) throw badRequest("needle is required.", { code: "notes_vault_needle_required" });
    res.json(await bridge!.contains(queryPath(req.query.path), needle));
  });

  router.get("/companies/:companyId/notes-vault/sync", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertNotesVaultAccess(accessFor(req, companyId), "read");
    res.json(await bridge!.syncStatus());
  });

  /** Syncs the vault with its cloud copy now instead of at the next scheduled sync. */
  router.post("/companies/:companyId/notes-vault/sync", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertNotesVaultAccess(accessFor(req, companyId), "write");
    const status = await bridge!.syncNow();
    const actorInfo = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actorInfo.actorType,
      actorId: actorInfo.actorId,
      agentId: actorInfo.agentId,
      runId: actorInfo.runId,
      agentApiKeyId: actorInfo.agentApiKeyId,
      action: "notes_vault.sync_requested",
      entityType: "notes_vault",
      entityId: companyId,
      details: {},
    });
    res.status(202).json(status);
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
