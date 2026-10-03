import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  activityLog,
  budgetPolicies,
  companies,
  companySecretBindings,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending approval agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pending approval agent config integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pending-agent-config-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(companySecretBindings);
    await db.delete(agents);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: true,
    });
    return companyId;
  }

  it("freezes generic pending hire config and reapplies the approval snapshot on activation", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const pending = await agentSvc.create(companyId, {
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Pending Coder",
        role: "engineer",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        runtimeConfig: { maxConcurrentRuns: 1 },
        budgetMonthlyCents: 1234,
        metadata: { source: "hire-form" },
        agentId: pending.id,
        appearance: pending.appearance,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    await expect(agentSvc.update(pending.id, {
      name: "Tampered Coder",
      adapterConfig: { command: "echo malicious" },
      runtimeConfig: { maxConcurrentRuns: 99 },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["name", "adapterConfig", "runtimeConfig"],
      },
    });
    await expect(agentSvc.updatePermissions(pending.id, {
      canCreateAgents: true,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["permissions"],
      },
    });

    await db
      .update(agents)
      .set({
        name: "Tampered Coder",
        adapterConfig: { command: "echo malicious" },
        runtimeConfig: { maxConcurrentRuns: 99 },
        metadata: { source: "tampered" },
      })
      .where(eq(agents.id, pending.id));

    await approvalSvc.approve(approval.id, "board-user", "Approved generic hire");

    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({
      status: "idle",
      appearance: pending.appearance,
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
    });
  });

  describe("hire approval decision checks", () => {
    const SAVED_URL = "https://gateway.example.test/v1";
    const OTHER_URL = "https://collector.example.test/v1";

    async function seedSecret(companyId: string, label: string) {
      return db.insert(companySecrets).values({
        companyId,
        key: `synthetic-${label}-${randomUUID()}`,
        name: `Synthetic ${label} ${randomUUID()}`,
      }).returning().then((rows) => rows[0]!.id);
    }

    function secretRef(secretId: string) {
      return { type: "secret_ref", secretId, version: "latest" };
    }

    async function seedPendingHermes(companyId: string, ownSecretId: string) {
      return agentService(db).create(companyId, {
        name: `Gateway ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        adapterType: "hermes_gateway",
        adapterConfig: { apiBaseUrl: SAVED_URL, apiKey: secretRef(ownSecretId) },
        status: "pending_approval",
        spentMonthlyCents: 0,
        permissions: {},
        lastHeartbeatAt: null,
      });
    }

    async function seedApproval(companyId: string, payload: Record<string, unknown>, status = "pending") {
      return approvalService(db).create(companyId, {
        type: "hire_agent",
        requestedByAgentId: null,
        requestedByUserId: "board-user",
        status,
        payload,
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });
    }

    async function approvalStatus(id: string) {
      return db.select().from(approvals).where(eq(approvals.id, id)).then((rows) => rows[0]!.status);
    }

    async function agentRow(id: string) {
      return db.select().from(agents).where(eq(agents.id, id)).then((rows) => rows[0] ?? null);
    }

    async function companyAgentCount(companyId: string) {
      return db.select().from(agents).where(eq(agents.companyId, companyId)).then((rows) => rows.length);
    }

    it("approves and activates the pending Hermes agent with its own saved key for the same gateway", async () => {
      const companyId = await seedCompany();
      const ownSecretId = await seedSecret(companyId, "own");
      const pending = await seedPendingHermes(companyId, ownSecretId);
      const approval = await seedApproval(companyId, {
        name: pending.name,
        adapterType: "hermes_gateway",
        adapterConfig: { apiBaseUrl: SAVED_URL, apiKey: secretRef(ownSecretId) },
        agentId: pending.id,
      });

      const first = await approvalService(db).approve(approval.id, "board-user", null);
      const repeat = await approvalService(db).approve(approval.id, "board-user", null);

      expect(first.applied).toBe(true);
      expect(repeat.applied).toBe(false);
      expect(await approvalStatus(approval.id)).toBe("approved");
      const activated = await agentRow(pending.id);
      expect(activated?.status).toBe("idle");
      expect((activated?.adapterConfig as Record<string, any>).apiKey.secretId).toBe(ownSecretId);
    });

    it("approves a hire whose stored payload was redacted, keeping the pending agent's real values", async () => {
      const companyId = await seedCompany();
      const ownSecretId = await seedSecret(companyId, "own");
      const pending = await agentService(db).create(companyId, {
        name: `Gateway ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        adapterType: "hermes_gateway",
        adapterConfig: {
          apiBaseUrl: SAVED_URL,
          apiKey: secretRef(ownSecretId),
          headers: { "X-Trace": "synthetic-real-header" },
        },
        status: "pending_approval",
        spentMonthlyCents: 0,
        permissions: {},
        lastHeartbeatAt: null,
      });
      // The agent hire flow stores a redacted copy of the saved config.
      const savedConfig = (await agentRow(pending.id))?.adapterConfig as Record<string, unknown>;
      const approval = await seedApproval(companyId, {
        name: pending.name,
        adapterType: "hermes_gateway",
        adapterConfig: { ...savedConfig, headers: { "X-Trace": "***REDACTED***" } },
        agentId: pending.id,
      });

      const result = await approvalService(db).approve(approval.id, "board-user", null);

      expect(result.applied).toBe(true);
      const activated = await agentRow(pending.id);
      expect(activated?.status).toBe("idle");
      expect((activated?.adapterConfig as Record<string, any>).headers).toEqual({ "X-Trace": "synthetic-real-header" });
    });

    for (const [label, makePayloadConfig, adapterType] of [
      [
        "an edited destination",
        (ownSecretId: string) => ({ apiBaseUrl: "https://collector.example.test/v1", apiKey: secretRef(ownSecretId), headers: { "X-Trace": "***REDACTED***" } }),
        "hermes_gateway",
      ],
      [
        "another adapter",
        () => ({ url: "https://collector.example.test/v1", headers: { "X-Trace": "***REDACTED***" } }),
        "http",
      ],
    ] as const) {
      it(`never fills a redacted placeholder from the saved config into ${label}`, async () => {
        const companyId = await seedCompany();
        const ownSecretId = await seedSecret(companyId, "own");
        const pending = await agentService(db).create(companyId, {
          name: `Gateway ${randomUUID().slice(0, 6)}`,
          role: "engineer",
          adapterType: "hermes_gateway",
          adapterConfig: { apiBaseUrl: SAVED_URL, apiKey: secretRef(ownSecretId), headers: { "X-Trace": "synthetic-real-header" } },
          status: "pending_approval",
          spentMonthlyCents: 0,
          permissions: {},
          lastHeartbeatAt: null,
        });
        const approval = await seedApproval(companyId, {
          name: pending.name,
          adapterType,
          adapterConfig: makePayloadConfig(ownSecretId),
          agentId: pending.id,
        });

        await expect(approvalService(db).approve(approval.id, "board-user", null)).rejects.toMatchObject({ status: 422 });

        expect(await approvalStatus(approval.id)).toBe("pending");
        const row = await agentRow(pending.id);
        expect(row?.status).toBe("pending_approval");
        expect(JSON.stringify(row?.adapterConfig)).not.toContain("collector.example.test");
      });
    }

    it("refuses a manual pause of a pending hire", async () => {
      const companyId = await seedCompany();
      const ownSecretId = await seedSecret(companyId, "own");
      const pending = await seedPendingHermes(companyId, ownSecretId);
      await expect(agentService(db).pause(pending.id)).rejects.toMatchObject({ status: 409 });
      expect((await agentRow(pending.id))?.status).toBe("pending_approval");
      await agentService(db).pause(pending.id, "budget");
      expect((await agentRow(pending.id))?.status).toBe("pending_approval");
    });

    for (const [label, makeConfig, code] of [
      [
        "sends the saved key to a new gateway URL",
        (own: string, _foreign: string) => ({ apiBaseUrl: OTHER_URL, apiKey: secretRef(own) }),
        "hermes_gateway_credential_rebind_required",
      ],
      [
        "borrows another stored secret as the token",
        (_own: string, foreign: string) => ({ apiBaseUrl: SAVED_URL, token: secretRef(foreign) }),
        "hermes_gateway_unbound_secret_ref",
      ],
    ] as const) {
      it(`keeps an old approval that ${label} open and the agent unchanged`, async () => {
        const companyId = await seedCompany();
        const ownSecretId = await seedSecret(companyId, "own");
        const foreignSecretId = await seedSecret(companyId, "foreign");
        const pending = await seedPendingHermes(companyId, ownSecretId);
        const before = await agentRow(pending.id);
        // Inserted directly, as an approval stored before the route checks existed.
        const approval = await seedApproval(companyId, {
          name: pending.name,
          adapterType: "hermes_gateway",
          adapterConfig: makeConfig(ownSecretId, foreignSecretId),
          agentId: pending.id,
        }, "revision_requested");

        await expect(approvalService(db).approve(approval.id, "board-user", null)).rejects.toMatchObject({
          status: 422,
          details: { code },
        });

        expect(await approvalStatus(approval.id)).toBe("revision_requested");
        expect(await agentRow(pending.id)).toEqual(before);
        const bindings = await db.select().from(companySecretBindings)
          .where(eq(companySecretBindings.secretId, foreignSecretId));
        expect(bindings).toEqual([]);
      });
    }

    it("defends activation itself against a borrowed key", async () => {
      const companyId = await seedCompany();
      const ownSecretId = await seedSecret(companyId, "own");
      const foreignSecretId = await seedSecret(companyId, "foreign");
      const pending = await seedPendingHermes(companyId, ownSecretId);
      const before = await agentRow(pending.id);

      await expect(agentService(db).activatePendingApproval(pending.id, {
        adapterType: "hermes_gateway",
        adapterConfig: { apiBaseUrl: SAVED_URL, apiKey: secretRef(foreignSecretId) },
      })).rejects.toMatchObject({ status: 422, details: { code: "hermes_gateway_unbound_secret_ref" } });
      expect(await agentRow(pending.id)).toEqual(before);
    });

    it("keeps an old no-agent Hermes approval with a stored secret open and creates no agent", async () => {
      const companyId = await seedCompany();
      const ownSecretId = await seedSecret(companyId, "own");
      const approval = await seedApproval(companyId, {
        name: "Gateway",
        adapterType: "hermes_gateway",
        adapterConfig: { apiBaseUrl: SAVED_URL, apiKey: secretRef(ownSecretId) },
      });

      await expect(approvalService(db).approve(approval.id, "board-user", null)).rejects.toMatchObject({
        status: 422,
        details: { code: "hermes_gateway_unbound_secret_ref" },
      });
      expect(await approvalStatus(approval.id)).toBe("pending");
      expect(await companyAgentCount(companyId)).toBe(0);
    });

    it("keeps an approval naming another company's pending agent open and that agent pending", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const otherPending = await agentService(db).create(otherCompanyId, {
        name: "Other Pending",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "echo other" },
        status: "pending_approval",
        spentMonthlyCents: 0,
        permissions: {},
        lastHeartbeatAt: null,
      });
      const approval = await seedApproval(companyId, {
        name: "Takeover",
        adapterConfig: { command: "echo takeover" },
        agentId: otherPending.id,
      });
      const missing = await seedApproval(companyId, { name: "Ghost", agentId: randomUUID() });

      for (const id of [approval.id, missing.id]) {
        await expect(approvalService(db).approve(id, "board-user", null)).rejects.toMatchObject({
          status: 422,
          details: { code: "hire_approval_agent_not_pending" },
        });
        expect(await approvalStatus(id)).toBe("pending");
      }
      expect(await agentRow(otherPending.id)).toMatchObject({
        status: "pending_approval",
        adapterConfig: { command: "echo other" },
      });

      await approvalService(db).reject(approval.id, "board-user", null);
      expect((await agentRow(otherPending.id))?.status).toBe("pending_approval");
    });

    it("rolls the approval back when the legacy agent create fails", async () => {
      const companyId = await seedCompany();
      const approval = await seedApproval(companyId, {
        name: "Broken",
        adapterType: "process",
        reportsTo: randomUUID(),
      });

      await expect(approvalService(db).approve(approval.id, "board-user", null)).rejects.toMatchObject({
        status: 404,
      });
      expect(await approvalStatus(approval.id)).toBe("pending");
      expect(await companyAgentCount(companyId)).toBe(0);
    });

    it("creates a legacy non-Hermes agent and approves in one commit", async () => {
      const companyId = await seedCompany();
      const approval = await seedApproval(companyId, {
        name: "Legacy Process",
        adapterType: "process",
        adapterConfig: { command: "echo legacy" },
      });

      const result = await approvalService(db).approve(approval.id, "board-user", null);

      expect(result.applied).toBe(true);
      expect(await approvalStatus(approval.id)).toBe("approved");
      expect(await companyAgentCount(companyId)).toBe(1);
    });

    it("refuses a resubmit after the approval was decided", async () => {
      const companyId = await seedCompany();
      const approval = await seedApproval(companyId, { name: "Legacy", adapterType: "process" }, "revision_requested");
      await approvalService(db).approve(approval.id, "board-user", null);

      await expect(approvalService(db).resubmit(approval.id, { name: "Swapped" })).rejects.toMatchObject({
        status: 422,
      });
      expect(await approvalStatus(approval.id)).toBe("approved");
    });
  });
});
