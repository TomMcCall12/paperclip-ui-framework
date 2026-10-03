import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  create: vi.fn(),
  findMentionedAgents: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  saveIssueVote: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
  reportRunActivity: vi.fn(),
  getRun: vi.fn(),
  getActiveRunForAgent: vi.fn(),
  cancelRun: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  listCompanyIds: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(),
}));

const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{ companyId: "company-1", agentId: "agent-1", contextSnapshot: null }]).then(
      onFulfilled,
      onRejected,
    ),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
}));

function registerRouteMocks() {
  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/execution-workspaces.js", () => ({
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    STALE_REOPEN_PENDING_CONSUMPTION_GRACE_MS: 5 * 60 * 1000,
  }));

  vi.doMock("../services/feedback.js", () => ({
    feedbackService: () => mockFeedbackService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/routines.js", () => ({
    routineService: () => mockRoutineService,
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    feedbackService: () => mockFeedbackService,
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueThreadInteractionService: () => ({
      listForIssue: vi.fn(async () => []),
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => mockRoutineService,
    workProductService: () => ({}),
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1000",
    title: "Workspace authz",
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("issue workspace command authorization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/execution-workspaces.js");
    vi.doUnmock("../services/feedback.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockIssueService.addComment.mockResolvedValue(null);
    mockIssueService.create.mockResolvedValue(makeIssue());
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.update.mockResolvedValue(makeIssue());
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: null,
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockFeedbackService.listIssueVotesForUser.mockResolvedValue([]);
    mockFeedbackService.saveIssueVote.mockResolvedValue({
      vote: null,
      consentEnabledNow: false,
      sharingEnabled: false,
    });
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockLogActivity.mockResolvedValue(undefined);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{ companyId: "company-1", agentId: "agent-1", contextSnapshot: null }]).then(
          onFulfilled,
          onRejected,
        ),
    }));
  });

  it("rejects agent callers that create issue workspace runtime provision commands", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Exploit",
        executionWorkspaceSettings: {
          workspaceStrategy: {
            type: "git_worktree",
            runtimeProvisionCommand: "touch /tmp/paperclip-rce",
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("host-executed workspace commands");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects agent callers that patch assignee adapter workspace teardown commands", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({
        assigneeAdapterOverrides: {
          adapterConfig: {
            workspaceStrategy: {
              type: "git_worktree",
              teardownCommand: "rm -rf /tmp/paperclip-rce",
            },
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("host-executed workspace commands");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});

describe("issue assignee adapter override credential guard", () => {
  const hermesAgent = {
    id: "33333333-3333-4333-8333-333333333333",
    companyId: "company-1",
    status: "idle",
    adapterType: "hermes_gateway",
    adapterConfig: { apiBaseUrl: "https://hermes.internal", apiKey: "saved-hermes-key" },
    permissions: null,
  };
  const claudeAgent = {
    id: "44444444-4444-4444-8444-444444444444",
    companyId: "company-1",
    status: "idle",
    adapterType: "claude_local",
    adapterConfig: {},
    permissions: null,
  };
  const agentsById = new Map<string, Record<string, unknown>>([
    [hermesAgent.id, hermesAgent],
    [claudeAgent.id, claudeAgent],
    ["agent-1", { id: "agent-1", companyId: "company-1", permissions: null }],
  ]);
  // A company member with issue write access who is not an instance admin.
  const memberActor = {
    type: "board",
    userId: "member-user",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
  };

  beforeEach(() => {
    vi.resetModules();
    registerRouteMocks();
    vi.clearAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, data: Record<string, unknown>) =>
      makeIssue({ assigneeAgentId: hermesAgent.id, ...data }),
    );
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "issue:mutate",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockImplementation(async (id: string) => agentsById.get(id) ?? null);
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockLogActivity.mockResolvedValue(undefined);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
  });

  it("rejects an authorized non-admin PATCH that points a Hermes assignee at a new gateway URL", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: hermesAgent.id }));
    const app = await createApp(memberActor);

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({
        assigneeAdapterOverrides: {
          adapterConfig: { apiBaseUrl: "https://attacker.example" },
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.details?.code).toBe("issue_assignee_override_not_allowed");
    expect(JSON.stringify(res.body)).not.toContain("saved-hermes-key");
    expect(JSON.stringify(res.body)).not.toContain("hermes.internal");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects credential and unknown keys, not only URL aliases", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: hermesAgent.id }));
    const app = await createApp(memberActor);

    for (const adapterConfig of [
      { model: "hermes-task-model", token: "attacker-token" },
      { headers: { Authorization: "Bearer x" } },
      { someFutureTransportKey: "x" },
      { model: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" } },
    ]) {
      const res = await request(app)
        .patch("/api/issues/issue-1")
        .send({ assigneeAdapterOverrides: { adapterConfig } });
      expect(res.status).toBe(422);
      expect(res.body.details?.code).toBe("issue_assignee_override_not_allowed");
    }
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("does not reveal the assignee guard to a caller without access", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: hermesAgent.id }));
    const app = await createApp({ ...memberActor, companyIds: ["company-2"] });

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({ assigneeAdapterOverrides: { adapterConfig: { apiBaseUrl: "https://attacker.example" } } });

    // The issue is hidden from the caller, so it learns nothing about the assignee.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("issue_assignee_override_not_allowed");
    expect(mockAgentService.getById).not.toHaveBeenCalledWith(hermesAgent.id);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects creating a Hermes-assigned issue with a gateway URL override", async () => {
    mockAgentService.resolveByReference.mockResolvedValue({ agent: hermesAgent, ambiguous: false });
    const app = await createApp(memberActor);

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Redirect",
        status: "todo",
        assigneeAgentId: hermesAgent.id,
        assigneeAdapterOverrides: { adapterConfig: { apiBaseUrl: "https://attacker.example" } },
      });

    expect(res.status).toBe(422);
    expect(res.body.details?.code).toBe("issue_assignee_override_not_allowed");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects assigning a Hermes agent to an issue that already carries an unsafe override", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      assigneeAgentId: null,
      assigneeAdapterOverrides: { adapterConfig: { apiBaseUrl: "https://attacker.example" } },
    }));
    mockAgentService.resolveByReference.mockResolvedValue({ agent: hermesAgent, ambiguous: false });
    const app = await createApp(memberActor);

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({ assigneeAgentId: hermesAgent.id });

    expect(res.status).toBe(422);
    expect(res.body.details?.code).toBe("issue_assignee_override_not_allowed");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("accepts a Hermes model override and the top-level project workspace flag", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: hermesAgent.id }));
    const app = await createApp(memberActor);
    const assigneeAdapterOverrides = {
      adapterConfig: { model: "hermes-task-model" },
      useProjectWorkspace: true,
    };

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({ assigneeAdapterOverrides });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({ assigneeAdapterOverrides }),
    );
  });

  it("leaves other adapters' override keys unchanged", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: claudeAgent.id }));
    const app = await createApp(memberActor);
    const assigneeAdapterOverrides = {
      adapterConfig: { model: "claude-task-model", effort: "high", chrome: true, timeoutSec: 30 },
    };

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({ assigneeAdapterOverrides });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({ assigneeAdapterOverrides }),
    );
  });
});
