import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping new-agent Hermes secret_ref route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

// A reserved TLD: nothing here can ever resolve, and fetch is stubbed anyway.
const GATEWAY_URL = "https://attacker.hermes.invalid/v1";

function boardActor(): Express.Request["actor"] {
  return { type: "board", userId: "local-board", source: "local_implicit" };
}

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, source: "agent_jwt" };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("new Hermes gateway agents cannot borrow a stored company secret", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-create-hermes-ref-${randomUUID()}`);
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-create-hermes-ref-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(() => {
    // No request may reach a gateway. Fail loudly if one is attempted.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in test"));
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(requireBoardApprovalForNewAgents = false) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Hermes Ref Co ${companyId.slice(0, 8)}`,
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, permissions: Record<string, unknown>) {
    const [row] = await db
      .insert(agents)
      .values({
        companyId,
        name: `Caller ${randomUUID().slice(0, 8)}`,
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions,
      })
      .returning();
    return row!;
  }

  // A synthetic stored secret. The value is a fixed test string, never a real key.
  async function seedStoredSecret(companyId: string) {
    return secretService(db).create(companyId, {
      name: `stored-hermes-${randomUUID()}`,
      provider: "local_encrypted",
      value: "synthetic-stored-value",
    });
  }

  async function expectNothingPersisted(companyId: string, existingAgentCount = 0) {
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(existingAgentCount);
    expect(await db.select().from(approvals).where(eq(approvals.companyId, companyId))).toEqual([]);
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toEqual([]);
  }

  const routes = [
    { name: "direct create", path: (companyId: string) => `/api/companies/${companyId}/agents`, requireApproval: false },
    { name: "hire", path: (companyId: string) => `/api/companies/${companyId}/agent-hires`, requireApproval: true },
  ] as const;
  const credentialKeys = ["apiKey", "token"] as const;

  describe.each(routes)("$name", ({ path: routePath, requireApproval }) => {
    it.each(credentialKeys)("rejects a stored company secret_ref as %s with 422 and persists nothing", async (key) => {
      const companyId = await seedCompany(requireApproval);
      const secret = await seedStoredSecret(companyId);

      const res = await request(createApp(db, boardActor()))
        .post(routePath(companyId))
        .send({
          name: "Borrowing Hermes",
          role: "engineer",
          adapterType: "hermes_gateway",
          adapterConfig: { apiBaseUrl: GATEWAY_URL, [key]: { type: "secret_ref", secretId: secret.id } },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.details).toEqual({ code: "hermes_gateway_unbound_secret_ref" });
      expect(JSON.stringify(res.body)).not.toContain(secret.id);
      expect(JSON.stringify(res.body)).not.toContain("synthetic-stored-value");
      await expectNothingPersisted(companyId);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("gives the same 422 for an unknown secret id, so the response is no existence oracle", async () => {
      const companyId = await seedCompany(requireApproval);

      const res = await request(createApp(db, boardActor()))
        .post(routePath(companyId))
        .send({
          name: "Guessing Hermes",
          role: "engineer",
          adapterType: "hermes_gateway",
          adapterConfig: { apiBaseUrl: GATEWAY_URL, apiKey: { type: "secret_ref", secretId: randomUUID() } },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.details).toEqual({ code: "hermes_gateway_unbound_secret_ref" });
      await expectNothingPersisted(companyId);
    });

    it("denies an agent without agents:create before inspecting the secret_ref", async () => {
      const companyId = await seedCompany(requireApproval);
      const secret = await seedStoredSecret(companyId);
      const caller = await seedAgent(companyId, {});

      const res = await request(createApp(db, agentActor(companyId, caller.id)))
        .post(routePath(companyId))
        .send({
          name: "Unauthorized Hermes",
          role: "engineer",
          adapterType: "hermes_gateway",
          adapterConfig: { apiBaseUrl: GATEWAY_URL, apiKey: { type: "secret_ref", secretId: secret.id } },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain("hermes_gateway_unbound_secret_ref");
      expect(JSON.stringify(res.body)).not.toContain(secret.id);
      await expectNothingPersisted(companyId, 1);
    });

    it("denies a cross-company agent before inspecting the target company's secret_ref", async () => {
      const callerCompanyId = await seedCompany();
      const targetCompanyId = await seedCompany(requireApproval);
      const secret = await seedStoredSecret(targetCompanyId);
      const caller = await seedAgent(callerCompanyId, { canCreateAgents: true });

      const res = await request(createApp(db, agentActor(callerCompanyId, caller.id)))
        .post(routePath(targetCompanyId))
        .send({
          name: "Cross Company Hermes",
          role: "engineer",
          adapterType: "hermes_gateway",
          adapterConfig: { apiBaseUrl: GATEWAY_URL, apiKey: { type: "secret_ref", secretId: secret.id } },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain("hermes_gateway_unbound_secret_ref");
      await expectNothingPersisted(targetCompanyId);
    });

    it("accepts a freshly entered plain key and stores it as a new secret bound to the new agent", async () => {
      const companyId = await seedCompany(requireApproval);
      const freshKey = `synthetic-fresh-key-${randomUUID()}`;

      const res = await request(createApp(db, boardActor()))
        .post(routePath(companyId))
        .send({
          name: "Fresh Hermes",
          role: "engineer",
          adapterType: "hermes_gateway",
          adapterConfig: { apiBaseUrl: GATEWAY_URL, apiKey: { type: "plain", value: freshKey } },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(JSON.stringify(res.body)).not.toContain(freshKey);
      const createdId = (res.body.agent?.id ?? res.body.id) as string;
      const [row] = await db.select().from(agents).where(eq(agents.id, createdId));
      expect(JSON.stringify(row!.adapterConfig)).not.toContain(freshKey);
      const apiKey = (row!.adapterConfig as Record<string, unknown>).apiKey as { type: string; secretId: string };
      expect(apiKey.type).toBe("secret_ref");
      const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, createdId));
      expect(bindings).toEqual([expect.objectContaining({ secretId: apiKey.secretId, configPath: "apiKey" })]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it("still allows a stored company secret_ref in an unrelated adapter's env", async () => {
    const companyId = await seedCompany();
    const secret = await seedStoredSecret(companyId);

    const res = await request(createApp(db, boardActor()))
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Codex With Stored Key",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: { env: { OPENAI_API_KEY: { type: "secret_ref", secretId: secret.id } } },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});
