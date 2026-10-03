import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
  assertHireApprovalPayload: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
  const { errorHandler } = await import("../middleware/index.js");
  const { approvalRoutes } = await import("../routes/approvals.js");
  const { unprocessable } = await import("../errors.js");
  const {
    hermesHireApprovalViolation,
    hireApprovalPayloadAgentId,
    hireApprovalPayloadMayTargetHermes,
    hireApprovalTargetViolation,
  } = await import("../services/agent-model-options.js");
  return {
    errorHandler,
    approvalRoutes,
    unprocessable,
    hermesHireApprovalViolation,
    hireApprovalPayloadAgentId,
    hireApprovalPayloadMayTargetHermes,
    hireApprovalTargetViolation,
  };
});

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const { errorHandler, approvalRoutes } = routeModules.value;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

function createRouteDb(contextSnapshot: Record<string, unknown> = {}, runId = "run-1", agentId = "agent-1") {
  const runRows = [{
    id: runId,
    companyId: "company-1",
    agentId,
    contextSnapshot,
  }];
  return {
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve(
            Object.keys(selection).includes("contextSnapshot") ? runRows : [],
          ),
        })),
      })),
    })),
  } as any;
}

async function createAgentApp(options: { runId?: string; contextSnapshot?: Record<string, unknown> } = {}) {
  const { errorHandler, approvalRoutes } = routeModules.value;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: options.runId ?? "run-1",
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb(options.contextSnapshot, options.runId ?? "run-1")));
  app.use(errorHandler);
  return app;
}

describe("approval routes idempotent retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.list.mockReset();
    mockApprovalService.getById.mockReset();
    mockApprovalService.create.mockReset();
    mockApprovalService.approve.mockReset();
    mockApprovalService.reject.mockReset();
    mockApprovalService.requestRevision.mockReset();
    mockApprovalService.resubmit.mockReset();
    mockApprovalService.listComments.mockReset();
    mockApprovalService.addComment.mockReset();
    mockApprovalService.assertHireApprovalPayload.mockReset();
    mockApprovalService.assertHireApprovalPayload.mockResolvedValue(undefined);
    mockHeartbeatService.wakeup.mockReset();
    mockIssueApprovalService.listIssuesForApproval.mockReset();
    mockIssueApprovalService.linkManyForApproval.mockReset();
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockReset();
    mockLogActivity.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("does not emit duplicate approval side effects when approve is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "approved",
      payload: {},
      requestedByAgentId: "agent-1",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "rejected",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects approval decisions for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-2",
      companyId: "company-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-2/approve")
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Approval not found");
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("rejects approval revision requests for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-3",
      companyId: "company-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-3/request-revision")
      .send({ decisionNote: "Need changes" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Approval not found");
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
  });

  it("derives approval attribution from the authenticated actor on approve", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-4",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-4",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: null,
      },
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-4/approve")
      .send({ decidedByUserId: "forged-user", decisionNote: "ship it" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalledWith("approval-4", "user-1", "ship it");
  });

  it("derives approval attribution from the authenticated actor on reject", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-5",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-5",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-5/reject")
      .send({ decidedByUserId: "forged-user", decisionNote: "not now" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.reject).toHaveBeenCalledWith("approval-5", "user-1", "not now");
  });

  it("derives approval attribution from the authenticated actor on request revision", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-6",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockApprovalService.requestRevision.mockResolvedValue({
      id: "approval-6",
      companyId: "company-1",
      type: "hire_agent",
      status: "revision_requested",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-6/request-revision")
      .send({ decidedByUserId: "forged-user", decisionNote: "Need changes" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.requestRevision).toHaveBeenCalledWith(
      "approval-6",
      "user-1",
      "Need changes",
    );
  });

  it("lets agents create generic issue-linked board approval requests", async () => {
    mockApprovalService.create.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: { title: "Approve hosting spend" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: ["00000000-0000-0000-0000-000000000001"],
        payload: { title: "Approve hosting spend" },
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body).toMatchObject({
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
    });
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
      "approval-1",
      ["00000000-0000-0000-0000-000000000001"],
      { agentId: "agent-1", userId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "approval.created",
      }),
    );
  });

  it("blocks status-only recovery runs from creating approvals", async () => {
    const res = await request(await createAgentApp({
      contextSnapshot: {
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: { title: "Approve hosting spend" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.assertHireApprovalPayload).not.toHaveBeenCalled();
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
  });

  it("blocks status-only recovery runs from resubmitting approvals", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-7",
      companyId: "company-1",
      type: "request_board_approval",
      status: "revision_requested",
      payload: {},
      requestedByAgentId: "agent-1",
    });

    const res = await request(await createAgentApp({
      contextSnapshot: {
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/approvals/approval-7/resubmit")
      .send({ payload: { title: "Retry" } });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("blocks status-only recovery runs from commenting on approvals", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-8",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    });

    const res = await request(await createAgentApp({
      contextSnapshot: {
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/approvals/approval-8/comments")
      .send({ body: "please approve" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.addComment).not.toHaveBeenCalled();
  });
});

describe("generic hire approval Hermes credential binding", () => {
  const COMPANY_ID = "company-1";
  const PENDING_AGENT_ID = "11111111-1111-4111-8111-111111111111";
  const OWN_SECRET_ID = "22222222-2222-4222-8222-222222222222";
  const FOREIGN_SECRET_ID = "33333333-3333-4333-8333-333333333333";
  const SAVED_URL = "https://gateway.example.test/v1";
  const ATTACKER_URL = "https://collector.example.test/v1";
  const agentFixtures = new Map<string, {
    companyId: string;
    status: string;
    adapterType: string;
    adapterConfig: Record<string, unknown>;
  }>();

  function secretRef(secretId: string) {
    return { type: "secret_ref", secretId, version: "latest" };
  }

  function hermesPayload(overrides: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
    return {
      name: "Gateway Agent",
      role: "engineer",
      adapterType: "hermes_gateway",
      adapterConfig: { apiBaseUrl: SAVED_URL, apiKey: secretRef(OWN_SECRET_ID), ...config },
      agentId: PENDING_AGENT_ID,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    agentFixtures.clear();
    agentFixtures.set(PENDING_AGENT_ID, {
      companyId: COMPANY_ID,
      status: "pending_approval",
      adapterType: "hermes_gateway",
      adapterConfig: { apiBaseUrl: SAVED_URL, apiKey: secretRef(OWN_SECRET_ID) },
    });
    // The route test keeps the agent lookup in a fixture map and runs the real
    // pure Hermes check, so the route wiring and the decision rule are both
    // exercised without a database.
    mockApprovalService.assertHireApprovalPayload.mockReset();
    mockApprovalService.assertHireApprovalPayload.mockImplementation(
      async (companyId: string, payload: Record<string, unknown>, opts: { requireAgentHire: boolean }) => {
        const {
          hermesHireApprovalViolation,
          hireApprovalPayloadAgentId,
          hireApprovalPayloadMayTargetHermes,
          hireApprovalTargetViolation,
          unprocessable,
        } = routeModules.value;
        const agentId = hireApprovalPayloadAgentId(payload);
        const target = agentId ? agentFixtures.get(agentId) ?? null : null;
        const targetViolation = hireApprovalTargetViolation({ companyId, payload, target });
        if (targetViolation) throw unprocessable(targetViolation.message, { code: targetViolation.code });
        if (!hireApprovalPayloadMayTargetHermes(payload)) return;
        const violation = hermesHireApprovalViolation({
          companyId,
          payload,
          target,
          requireAgentHire: opts.requireAgentHire,
        });
        if (violation) throw unprocessable(violation.message, { code: violation.code });
      },
    );
    mockApprovalService.create.mockReset();
    mockApprovalService.create.mockImplementation(async (companyId: string, data: Record<string, unknown>) => ({
      id: "approval-hermes",
      companyId,
      ...data,
    }));
    mockApprovalService.resubmit.mockReset();
    mockApprovalService.resubmit.mockImplementation(async (id: string, payload?: Record<string, unknown>) => ({
      id,
      companyId: COMPANY_ID,
      type: "hire_agent",
      status: "pending",
      payload: payload ?? {},
    }));
    mockApprovalService.getById.mockReset();
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-hermes",
      companyId: COMPANY_ID,
      type: "hire_agent",
      status: "revision_requested",
      payload: hermesPayload(),
      requestedByAgentId: "agent-1",
    });
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockReset();
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockImplementation(
      async (_companyId: string, payload: Record<string, unknown>) => payload,
    );
    mockIssueApprovalService.linkManyForApproval.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
  });

  async function createHire(payload: Record<string, unknown>) {
    return request(await createAgentApp())
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send({ type: "hire_agent", payload });
  }

  async function resubmitHire(payload: Record<string, unknown>) {
    return request(await createAgentApp())
      .post("/api/approvals/approval-hermes/resubmit")
      .send({ payload });
  }

  function expectRejected(
    res: request.Response,
    code:
      | "hermes_gateway_unbound_secret_ref"
      | "hermes_gateway_credential_rebind_required"
      | "hire_approval_agent_not_pending",
  ) {
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toEqual({ code });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(PENDING_AGENT_ID);
    expect(body).not.toContain(OWN_SECRET_ID);
    expect(body).not.toContain(FOREIGN_SECRET_ID);
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).not.toHaveBeenCalled();
  }

  for (const alias of ["apiKey", "token"] as const) {
    it(`rejects a generic create that borrows another company secret as the ${alias}`, async () => {
      const res = await createHire(hermesPayload({}, { apiKey: undefined, [alias]: secretRef(FOREIGN_SECRET_ID) }));
      expectRejected(res, "hermes_gateway_unbound_secret_ref");
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    });

    it(`rejects a generic resubmit that borrows another company secret as the ${alias}`, async () => {
      const res = await resubmitHire(hermesPayload({}, { apiKey: undefined, [alias]: secretRef(FOREIGN_SECRET_ID) }));
      expectRejected(res, "hermes_gateway_unbound_secret_ref");
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
    });

    it(`rejects a generic create that sends the saved ${alias} to a new gateway URL`, async () => {
      agentFixtures.set(PENDING_AGENT_ID, {
        companyId: COMPANY_ID,
        status: "pending_approval",
        adapterType: "hermes_gateway",
        adapterConfig: { apiBaseUrl: SAVED_URL, [alias]: secretRef(OWN_SECRET_ID) },
      });
      const res = await createHire(
        hermesPayload({}, { apiKey: undefined, apiBaseUrl: ATTACKER_URL, [alias]: secretRef(OWN_SECRET_ID) }),
      );
      expectRejected(res, "hermes_gateway_credential_rebind_required");
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    });
  }

  it("rejects a generic resubmit that sends the saved key to a new gateway URL", async () => {
    const res = await resubmitHire(hermesPayload({}, { apiBaseUrl: ATTACKER_URL }));
    expectRejected(res, "hermes_gateway_credential_rebind_required");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("rejects a generic create that switches the plain-HTTP transport for the saved key", async () => {
    const res = await createHire(hermesPayload({}, { dangerouslyAllowInsecureRemoteHttp: true }));
    expectRejected(res, "hermes_gateway_credential_rebind_required");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("accepts the pending agent's own saved key for the same gateway", async () => {
    const payload = hermesPayload();
    const res = await createHire(payload);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.assertHireApprovalPayload).toHaveBeenCalledWith(
      COMPANY_ID,
      payload,
      { requireAgentHire: true },
    );
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).toHaveBeenCalledWith(
      COMPANY_ID,
      payload,
      { strictMode: false },
    );
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
  });

  it("accepts a resubmit that keeps the own saved key for the same gateway", async () => {
    const res = await resubmitHire(hermesPayload());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockApprovalService.resubmit).toHaveBeenCalledTimes(1);
  });

  it("accepts a new plain key typed for a new gateway URL on the pending agent", async () => {
    const res = await createHire(hermesPayload({}, { apiBaseUrl: ATTACKER_URL, apiKey: "synthetic-new-key" }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  for (const [label, payload] of [
    ["a stored secret", hermesPayload({ agentId: undefined }, { apiKey: secretRef(FOREIGN_SECRET_ID) })],
    ["a stored token secret", hermesPayload({ agentId: undefined }, { apiKey: undefined, token: secretRef(OWN_SECRET_ID) })],
    ["a plain key", hermesPayload({ agentId: undefined }, { apiKey: "synthetic-plain-key" })],
    ["a non-string Hermes adapter type", hermesPayload({ agentId: undefined, adapterType: ["hermes_gateway"] })],
  ] as const) {
    it(`requires the agent hire flow for a new Hermes agent with ${label} and no agent id`, async () => {
      const createRes = await createHire(payload);
      expectRejected(createRes, "hermes_gateway_unbound_secret_ref");
      expect(createRes.body.error).toContain("agent-hires");
      expect(mockApprovalService.create).not.toHaveBeenCalled();

      const resubmitRes = await resubmitHire(payload);
      expectRejected(resubmitRes, "hermes_gateway_unbound_secret_ref");
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
    });
  }

  const TARGET_CASES = [
    ["an unknown agent", null],
    ["another company's pending agent", {
      companyId: "company-2",
      status: "pending_approval",
      adapterType: "hermes_gateway",
      adapterConfig: { apiBaseUrl: SAVED_URL, apiKey: secretRef(FOREIGN_SECRET_ID) },
    }],
    ["an already active agent", {
      companyId: COMPANY_ID,
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: { apiBaseUrl: SAVED_URL, apiKey: secretRef(OWN_SECRET_ID) },
    }],
  ] as const;

  const TARGET_PAYLOADS = [
    ["Hermes", () => hermesPayload()],
    ["adapter-type-omitted", () => ({ name: "No Type", agentId: PENDING_AGENT_ID })],
    ["non-Hermes", () => ({
      name: "Process Agent",
      adapterType: "process",
      adapterConfig: { command: "echo ok" },
      agentId: PENDING_AGENT_ID,
    })],
  ] as const;

  for (const [targetLabel, target] of TARGET_CASES) {
    for (const [payloadLabel, makePayload] of TARGET_PAYLOADS) {
      it(`rejects a ${payloadLabel} hire approval that names ${targetLabel}`, async () => {
        if (target) agentFixtures.set(PENDING_AGENT_ID, { ...target, adapterConfig: { ...target.adapterConfig } });
        else agentFixtures.delete(PENDING_AGENT_ID);

        const createRes = await createHire(makePayload());
        expectRejected(createRes, "hire_approval_agent_not_pending");
        expect(mockApprovalService.create).not.toHaveBeenCalled();

        const resubmitRes = await resubmitHire(makePayload());
        expectRejected(resubmitRes, "hire_approval_agent_not_pending");
        expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
      });
    }
  }

  it("answers a missing agent and another company's agent identically", async () => {
    agentFixtures.delete(PENDING_AGENT_ID);
    const missing = await createHire(hermesPayload());
    agentFixtures.set(PENDING_AGENT_ID, { ...TARGET_CASES[1][1], adapterConfig: {} });
    const foreign = await createHire(hermesPayload());

    expect(missing.status).toBe(422);
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
  });

  it("accepts a non-Hermes hire approval for this company's pending agent", async () => {
    agentFixtures.set(PENDING_AGENT_ID, {
      companyId: COMPANY_ID,
      status: "pending_approval",
      adapterType: "process",
      adapterConfig: { command: "echo ok" },
    });
    const res = await createHire({ name: "Process Agent", adapterType: "process", agentId: PENDING_AGENT_ID });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("leaves non-Hermes generic hire approvals unchanged", async () => {
    const payload = {
      name: "Process Agent",
      adapterType: "process",
      adapterConfig: { command: "echo ok", env: { API_KEY: secretRef(FOREIGN_SECRET_ID) } },
    };
    const res = await createHire(payload);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).toHaveBeenCalledWith(
      COMPANY_ID,
      payload,
      { strictMode: false },
    );
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ payload }),
    );
  });

  it("checks the actor's company access before the Hermes check", async () => {
    const res = await request(await createAgentApp())
      .post("/api/companies/company-2/approvals")
      .send({ type: "hire_agent", payload: hermesPayload() });

    expect(res.status).toBe(403);
    expect(mockApprovalService.assertHireApprovalPayload).not.toHaveBeenCalled();
  });

  it("checks the requesting agent before the Hermes check on resubmit", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-hermes",
      companyId: COMPANY_ID,
      type: "hire_agent",
      status: "revision_requested",
      payload: hermesPayload(),
      requestedByAgentId: "someone-else",
    });
    const res = await resubmitHire(hermesPayload({}, { apiKey: secretRef(FOREIGN_SECRET_ID) }));

    expect(res.status).toBe(403);
    expect(mockApprovalService.assertHireApprovalPayload).not.toHaveBeenCalled();
  });
});
