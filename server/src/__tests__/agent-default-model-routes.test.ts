import express from "express";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  update: vi.fn(),
}));

const mockAdapterPluginStore = vi.hoisted(() => ({
  getDisabledAdapterTypes: vi.fn<() => string[]>(() => []),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
  syncEnvBindingsForTarget: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({ defaultEnvironmentId: null })),
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  getExperimental: vi.fn(async () => ({ enableNativeRunner: false })),
}));

const mockManagedAgentProfileService = vi.hoisted(() => ({
  requireQualified: vi.fn(),
}));

const mockRemoteAgentProfileService = vi.hoisted(() => ({
  requireQualified: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/managed-agent-profiles.js", () => ({
  managedAgentProfileService: () => mockManagedAgentProfileService,
}));

vi.mock("../services/remote-agent-profiles.js", () => ({
  remoteAgentProfileService: () => mockRemoteAgentProfileService,
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/managed-agent-profiles.js", () => ({
    managedAgentProfileService: () => mockManagedAgentProfileService,
  }));

  vi.doMock("../services/remote-agent-profiles.js", () => ({
    remoteAgentProfileService: () => mockRemoteAgentProfileService,
  }));

  // The adapter registry reads the disabled set from this store. Mock it so a
  // test can declare an adapter disabled without writing to the real
  // ~/.paperclip/adapter-settings.json.
  vi.doMock("../services/adapter-plugin-store.js", () => ({
    getDisabledAdapterTypes: mockAdapterPluginStore.getDisabledAdapterTypes,
    isAdapterDisabled: (type: string) =>
      mockAdapterPluginStore.getDisabledAdapterTypes().includes(type),
    listAdapterPlugins: () => [],
    getAdapterPluginByType: () => undefined,
    setAdapterDisabled: vi.fn(),
  }));
}


async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "company-1",
            requireBoardApprovalForNewAgents: false,
          },
        ]),
      })),
    })),
  };
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

const HERMES_KEY = "hermes-live-key-not-for-ui";
const JARVIS_ID = "22222222-2222-4222-8222-222222222222";
const ENGINEER_ID = "33333333-3333-4333-8333-333333333333";

function agentRecord(overrides: Record<string, unknown>) {
  return {
    companyId: "company-1",
    urlKey: "agent",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const jarvis = agentRecord({
  id: JARVIS_ID,
  name: "Jarvis",
  adapterType: "hermes_gateway",
  adapterConfig: {
    apiBaseUrl: "http://127.0.0.1:9119",
    apiKey: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" },
    model: "gpt-6.1-sol",
  },
});

const engineer = agentRecord({
  id: ENGINEER_ID,
  name: "Engineer",
  adapterType: "claude_local",
  adapterConfig: { model: "claude-sonnet-5" },
});

function gatewayResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("agent default model control", { timeout: 60_000 }, () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue([]);
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_explicit_grant", explanation: "Allowed by test grant" });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockLogActivity.mockResolvedValue(undefined);
    mockSecretService.syncEnvBindingsForTarget.mockResolvedValue(undefined);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId: string, config: Record<string, unknown>) => ({
      config: { ...config, apiKey: HERMES_KEY },
    }));
    mockAgentService.getById.mockImplementation(async (id: string) => (
      id === JARVIS_ID ? jarvis : id === ENGINEER_ID ? engineer : null
    ));
    mockAgentService.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      ...(await mockAgentService.getById(id)),
      ...patch,
    }));
    fetchMock = vi.fn(async () => gatewayResponse({
      model: "gpt-6.1-sol",
      provider: "openai-codex",
      models: [
        { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
        { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the Hermes gateway's supported models for Jarvis without exposing the key", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${JARVIS_ID}/model-options`));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      adapterType: "hermes_gateway",
      runtimeLabel: "Hermes Gateway",
      provider: "openai-codex",
      source: "hermes_gateway",
      status: "available",
      currentModel: "gpt-6.1-sol",
      currentModelListed: true,
      models: [
        { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
        { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain(HERMES_KEY);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9119/api/model/options");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${HERMES_KEY}`);
  });

  it("saves a gateway-supported Hermes default model through PATCH", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${JARVIS_ID}`)
      .send({ adapterConfig: { model: "gpt-5.6-terra" } }));

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      JARVIS_ID,
      expect.objectContaining({ adapterConfig: expect.objectContaining({ model: "gpt-5.6-terra" }) }),
      expect.anything(),
    );
  });

  it("rejects a Hermes model the gateway does not list and keeps the saved default", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${JARVIS_ID}`)
      .send({ adapterConfig: { model: "GPT-5.6 Terra" } }));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("GPT-5.6 Terra");
    expect(res.body.error).toMatch(/not offered by the Hermes gateway/i);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("fails closed when the gateway cannot confirm the model", async () => {
    fetchMock.mockResolvedValue(gatewayResponse({ error: "nope" }, 401));
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${JARVIS_ID}`)
      .send({ adapterConfig: { model: "gpt-5.6-terra" } }));

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/rejected the configured API key/i);
    expect(JSON.stringify(res.body)).not.toContain(HERMES_KEY);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("keeps an unchanged saved Hermes default without contacting the gateway", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${JARVIS_ID}`)
      .send({ adapterConfig: { model: "gpt-6.1-sol", timeoutSec: 900 } }));

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scopes the live Jarvis gateway catalog to its current authenticated provider", async () => {
    const liveJarvis = {
      ...jarvis,
      adapterConfig: {
        apiBaseUrl: "http://192.168.0.163:8642",
        dangerouslyAllowInsecureRemoteHttp: true,
        apiKey: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" },
        model: "gpt-6.1-sol",
      },
    };
    mockAgentService.getById.mockImplementation(async (id: string) => (id === JARVIS_ID ? liveJarvis : null));
    const livePayload = (codexAuthenticated: boolean) => ({
      provider: "openai-codex",
      model: "gpt-6.1-sol",
      providers: [
        { slug: "openrouter", name: "OpenRouter", authenticated: true, models: ["openrouter/only-model", "gpt-6.1-sol"] },
        { slug: "anthropic", name: "Anthropic", authenticated: true, models: ["claude-opus-5"] },
        { slug: "openai-codex", name: "OpenAI Codex", authenticated: codexAuthenticated, models: ["gpt-6.1-sol", "gpt-5.6-terra"] },
      ],
    });
    fetchMock.mockImplementation(async () => gatewayResponse(livePayload(true)));
    const app = await createApp();

    const options = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${JARVIS_ID}/model-options`));
    expect(options.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://192.168.0.163:8642/api/model/options");
    expect(options.body).toMatchObject({ provider: "openai-codex", status: "available", currentModelListed: true });
    expect(options.body.models.map((model: { id: string }) => model.id)).toEqual(["gpt-6.1-sol", "gpt-5.6-terra"]);
    expect(JSON.stringify(options.body)).not.toContain(HERMES_KEY);

    const otherProvider = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${JARVIS_ID}`)
      .send({ adapterConfig: { model: "openrouter/only-model" } }));
    expect(otherProvider.status).toBe(422);
    expect(otherProvider.body.error).toMatch(/not offered by the Hermes gateway/i);

    fetchMock.mockImplementation(async () => gatewayResponse(livePayload(false)));
    const unauthenticated = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${JARVIS_ID}`)
      .send({ adapterConfig: { model: "gpt-5.6-terra" } }));
    expect(unauthenticated.status).toBe(422);
    expect(unauthenticated.body.error).toMatch(/"openai-codex" is not authenticated/);
    expect(JSON.stringify(unauthenticated.body)).not.toContain(HERMES_KEY);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("lists the Claude catalog for the Engineer and rejects ids outside it", async () => {
    const adapters = await import("../adapters/index.js");
    const list = vi.spyOn(adapters, "listAdapterModels").mockImplementation(async () => [
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-opus-5", label: "Claude Opus 5" },
    ]);
    try {
      const app = await createApp();
      const options = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${ENGINEER_ID}/model-options`));
      expect(options.status).toBe(200);
      expect(options.body).toMatchObject({
        adapterType: "claude_local",
        source: "adapter_catalog",
        status: "unverified",
        currentModel: "claude-sonnet-5",
        currentModelListed: true,
      });
      expect(options.body.message).toMatch(/not verif/i);
      expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();

      const accepted = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${ENGINEER_ID}`)
        .send({ adapterConfig: { model: "claude-opus-5" } }));
      expect(accepted.status).toBe(200);

      const rejected = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${ENGINEER_ID}`)
        .send({ adapterConfig: { model: "Claude Opus 5" } }));
      expect(rejected.status).toBe(422);
      expect(rejected.body.error).toMatch(/not in Paperclip's Claude model catalog/i);
    } finally {
      list.mockRestore();
    }
  });

  it("does not list model options for callers without agent config update access", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "deny", explanation: "Not allowed" });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${JARVIS_ID}/model-options`));

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
