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


async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
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

  it("does not validate a default model change for callers without agent config update access", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "deny", explanation: "Not allowed" });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${JARVIS_ID}`)
      .send({ adapterConfig: { model: "gpt-5.6-terra" } }));

    expect(res.status).toBe(403);
    expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("does not list or validate models for an agent in another company", async () => {
    const foreignJarvis = { ...jarvis, companyId: "company-2" };
    mockAgentService.getById.mockImplementation(async (id: string) => (id === JARVIS_ID ? foreignJarvis : null));
    const actors = [
      { type: "board", userId: "user-1", companyIds: ["company-1"], source: "session", isInstanceAdmin: false },
      { type: "agent", agentId: ENGINEER_ID, companyId: "company-1", source: "agent_key" },
    ];
    for (const actor of actors) {
      const app = await createApp(actor);
      const options = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${JARVIS_ID}/model-options`));
      const patch = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${JARVIS_ID}`)
        .send({ adapterConfig: { model: "gpt-5.6-terra" } }));

      expect(options.status).toBe(404);
      expect(patch.status).toBe(404);
    }
    expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  describe("Hermes gateway credential rebind", () => {
    const SAVED_KEY_REF = jarvis.adapterConfig.apiKey;
    // Same company, never saved on Jarvis: another agent's stored key.
    const NEW_KEY_REF = { type: "secret_ref", secretId: "44444444-4444-4444-8444-444444444444", version: "latest" };
    const NEW_PLAIN_KEY = { type: "plain", value: "fresh-gateway-key-for-test" };
    const COLLECTOR_URL = "https://collector.example.test";

    function expectSavedKeyNeverUsed(res: request.Response) {
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/API key/i);
      expect(JSON.stringify(res.body)).not.toContain(HERMES_KEY);
      expect(JSON.stringify(res.body)).not.toContain(SAVED_KEY_REF.secretId);
      expect(mockSecretService.normalizeAdapterConfigForPersistence).not.toHaveBeenCalled();
      expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockAgentService.update).not.toHaveBeenCalled();
    }

    it("rejects a gateway URL and model change that keeps the saved key before resolving it", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${JARVIS_ID}`)
        .send({ adapterConfig: { apiBaseUrl: COLLECTOR_URL, model: "gpt-5.6-terra" } }));

      expectSavedKeyNeverUsed(res);
    });

    it("rejects a gateway URL change that re-sends the saved key reference", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${JARVIS_ID}`)
        .send({
          replaceAdapterConfig: true,
          adapterConfig: { apiBaseUrl: COLLECTOR_URL, apiKey: SAVED_KEY_REF, model: "gpt-5.6-terra" },
        }));

      expectSavedKeyNeverUsed(res);
    });

    it("rejects a URL-only change that keeps the saved key, so model options never probe the new gateway", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${JARVIS_ID}`)
        .send({ adapterConfig: { apiBaseUrl: COLLECTOR_URL } }));

      expectSavedKeyNeverUsed(res);

      const options = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${JARVIS_ID}/model-options`));
      expect(options.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9119/api/model/options");
    });

    it("answers an unauthorized URL change with 403 before the rebind rule or any secret use", async () => {
      mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "deny", explanation: "Not allowed" });
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${JARVIS_ID}`)
        .send({ adapterConfig: { apiBaseUrl: COLLECTOR_URL, model: "gpt-5.6-terra" } }));

      expect(res.status).toBe(403);
      expect(res.body.error).not.toMatch(/API key/i);
      expect(mockSecretService.normalizeAdapterConfigForPersistence).not.toHaveBeenCalled();
      expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("rejects enabling remote plain HTTP while keeping the saved key", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${JARVIS_ID}`)
        .send({ adapterConfig: { apiBaseUrl: "http://203.0.113.9:8642", dangerouslyAllowInsecureRemoteHttp: true } }));

      expectSavedKeyNeverUsed(res);
    });

    it("accepts a gateway URL change that supplies a new key and validates the model against the new gateway", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${JARVIS_ID}`)
        .send({ adapterConfig: { apiBaseUrl: "https://new-gateway.example.test", apiKey: NEW_PLAIN_KEY, model: "gpt-5.6-terra" } }));

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://new-gateway.example.test/api/model/options");
      const resolvedConfig = mockSecretService.resolveAdapterConfigForRuntime.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(resolvedConfig.apiKey).toEqual(NEW_PLAIN_KEY);
      expect(mockAgentService.update).toHaveBeenCalledTimes(1);
    });

    it("keeps the saved-key rebind code for a URL change that re-sends the saved key", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${JARVIS_ID}`)
        .send({ adapterConfig: { apiBaseUrl: COLLECTOR_URL, apiKey: SAVED_KEY_REF } }));

      expectSavedKeyNeverUsed(res);
      expect(res.body.details).toEqual({ code: "hermes_gateway_credential_rebind_required" });
    });

    describe("another stored secret at the saved gateway", () => {
      function expectRejectedBeforeSecretUse(res: request.Response) {
        expectSavedKeyNeverUsed(res);
        expect(res.body.details).toEqual({ code: "hermes_gateway_unbound_secret_ref" });
        expect(JSON.stringify(res.body)).not.toContain(NEW_KEY_REF.secretId);
        expect(mockLogActivity).not.toHaveBeenCalled();
      }

      it.each([
        { name: "apiKey", replace: false, adapterConfig: { apiKey: NEW_KEY_REF } },
        { name: "token alias beside the saved apiKey", replace: false, adapterConfig: { token: NEW_KEY_REF } },
        { name: "full config re-sent with only the key changed", replace: true, adapterConfig: { ...jarvis.adapterConfig, apiKey: NEW_KEY_REF } },
        { name: "model change with the key changed", replace: false, adapterConfig: { apiKey: NEW_KEY_REF, model: "gpt-5.6-terra" } },
      ])("rejects a substituted $name before normalizing, resolving, or saving", async ({ replace, adapterConfig }) => {
        const app = await createApp();
        const res = await requestApp(app, (baseUrl) => request(baseUrl)
          .patch(`/api/agents/${JARVIS_ID}`)
          .send({ ...(replace ? { replaceAdapterConfig: true } : {}), adapterConfig }));

        expectRejectedBeforeSecretUse(res);
      });

      it("answers an unauthorized substitution with 403 and no hint about the reference", async () => {
        mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "deny", explanation: "Not allowed" });
        const app = await createApp();
        const res = await requestApp(app, (baseUrl) => request(baseUrl)
          .patch(`/api/agents/${JARVIS_ID}`)
          .send({ adapterConfig: { apiKey: NEW_KEY_REF } }));

        expect(res.status).toBe(403);
        expect(JSON.stringify(res.body)).not.toContain("hermes_gateway_unbound_secret_ref");
        expect(res.body.error).not.toMatch(/API key|stored key/i);
        expect(mockSecretService.normalizeAdapterConfigForPersistence).not.toHaveBeenCalled();
        expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
        expect(mockAgentService.update).not.toHaveBeenCalled();
      });

      it("rejects the agent's own reference moved to the token alias, which is never resolved", async () => {
        const app = await createApp();
        const res = await requestApp(app, (baseUrl) => request(baseUrl)
          .patch(`/api/agents/${JARVIS_ID}`)
          .send({
            replaceAdapterConfig: true,
            adapterConfig: { apiBaseUrl: jarvis.adapterConfig.apiBaseUrl, token: SAVED_KEY_REF, model: "gpt-6.1-sol" },
          }));

        expectRejectedBeforeSecretUse(res);
        expect(res.body.error).toMatch(/apiKey, not token/);
      });

      it("saves a fresh plain key at the saved gateway", async () => {
        const app = await createApp();
        const res = await requestApp(app, (baseUrl) => request(baseUrl)
          .patch(`/api/agents/${JARVIS_ID}`)
          .send({ adapterConfig: { apiKey: NEW_PLAIN_KEY } }));

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(mockSecretService.normalizeAdapterConfigForPersistence.mock.calls[0]?.[1]).toMatchObject({ apiKey: NEW_PLAIN_KEY });
        expect(mockAgentService.update).toHaveBeenCalledTimes(1);
      });

      it("leaves a stored secret on a non-Hermes adapter alone", async () => {
        const app = await createApp();
        const res = await requestApp(app, (baseUrl) => request(baseUrl)
          .patch(`/api/agents/${ENGINEER_ID}`)
          .send({ adapterConfig: { env: { ANTHROPIC_API_KEY: NEW_KEY_REF } } }));

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(mockAgentService.update).toHaveBeenCalledTimes(1);
      });
    });

    it("keeps model selection working on the saved live Jarvis gateway when the form re-sends its config", async () => {
      const liveConfig = {
        apiBaseUrl: "http://192.168.0.163:8642",
        dangerouslyAllowInsecureRemoteHttp: true,
        apiKey: SAVED_KEY_REF,
        model: "gpt-6.1-sol",
      };
      mockAgentService.getById.mockImplementation(async (id: string) => (
        id === JARVIS_ID ? { ...jarvis, adapterConfig: liveConfig } : null
      ));
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${JARVIS_ID}`)
        .send({ replaceAdapterConfig: true, adapterConfig: { ...liveConfig, model: "gpt-5.6-terra" } }));

      expect(res.status).toBe(200);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("http://192.168.0.163:8642/api/model/options");
    });
  });

  describe("adapter switches onto a validated default model runtime", () => {
    const CODEX_ID = "55555555-5555-4555-8555-555555555555";
    const GATEWAY_ID = "66666666-6666-4666-8666-666666666666";
    const GATEWAY_KEY_REF = { type: "secret_ref", secretId: "77777777-7777-4777-8777-777777777777", version: "latest" };
    const FRESH_GATEWAY_KEY = { type: "plain", value: "fresh-switch-key-for-test" };
    const codexAgent = agentRecord({
      id: CODEX_ID,
      name: "Codex",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.5" },
    });
    const gatewayAgent = agentRecord({
      id: GATEWAY_ID,
      name: "Gateway",
      adapterType: "openclaw_gateway",
      adapterConfig: { url: "wss://gateway.example.test", apiKey: GATEWAY_KEY_REF },
    });
    let listModels: { mockRestore: () => void } | null = null;

    beforeEach(async () => {
      mockAgentService.getById.mockImplementation(async (id: string) => (
        id === CODEX_ID ? codexAgent : id === GATEWAY_ID ? gatewayAgent : id === ENGINEER_ID ? engineer : null
      ));
      const adapters = await import("../adapters/index.js");
      listModels = vi.spyOn(adapters, "listAdapterModels").mockImplementation(async (type: string) => (
        type === "claude_local"
          ? [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }]
          : [{ id: "gpt-5.5", label: "GPT-5.5" }]
      ));
    });

    afterEach(() => {
      listModels?.mockRestore();
      listModels = null;
    });

    it("rejects an unsupported model when switching to claude_local", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${CODEX_ID}`)
        .send({ adapterType: "claude_local", adapterConfig: { model: "gpt-5.5" } }));

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/not in Paperclip's Claude model catalog/i);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("accepts a catalog model or the runtime default when switching to claude_local", async () => {
      const app = await createApp();
      const listed = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${CODEX_ID}`)
        .send({ adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-5" } }));
      const runtimeDefault = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${CODEX_ID}`)
        .send({ adapterType: "claude_local", adapterConfig: {} }));

      expect(listed.status).toBe(200);
      expect(runtimeDefault.status).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalledTimes(2);
    });

    it("rejects a model the target Hermes gateway does not list when switching to hermes_gateway", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${CODEX_ID}`)
        .send({
          adapterType: "hermes_gateway",
          adapterConfig: { apiBaseUrl: "https://new-gateway.example.test", apiKey: FRESH_GATEWAY_KEY, model: "gpt-5.5" },
        }));

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/not offered by the Hermes gateway/i);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://new-gateway.example.test/api/model/options");
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("accepts a gateway-listed model when switching to hermes_gateway", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${CODEX_ID}`)
        .send({
          adapterType: "hermes_gateway",
          adapterConfig: { apiBaseUrl: "https://new-gateway.example.test", apiKey: FRESH_GATEWAY_KEY, model: "gpt-5.6-terra" },
        }));

      expect(res.status).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalledTimes(1);
    });

    it("does not carry a saved key into a switch to hermes_gateway", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${GATEWAY_ID}`)
        .send({
          adapterType: "hermes_gateway",
          adapterConfig: { apiBaseUrl: "https://collector.example.test", apiKey: GATEWAY_KEY_REF, model: "gpt-5.6-terra" },
        }));

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/API key/i);
      expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("keeps no stored secret on a switch onto hermes_gateway", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${CODEX_ID}`)
        .send({
          adapterType: "hermes_gateway",
          adapterConfig: { apiBaseUrl: "https://new-gateway.example.test", token: GATEWAY_KEY_REF, model: "gpt-5.6-terra" },
        }));

      expect(res.status).toBe(422);
      expect(res.body.details).toEqual({ code: "hermes_gateway_unbound_secret_ref" });
      expect(JSON.stringify(res.body)).not.toContain(GATEWAY_KEY_REF.secretId);
      expect(mockSecretService.normalizeAdapterConfigForPersistence).not.toHaveBeenCalled();
      expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("leaves switches to adapters without default model control unvalidated", async () => {
      const app = await createApp();
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${ENGINEER_ID}`)
        .send({ adapterType: "codex_local", adapterConfig: { model: "any-codex-model" } }));

      expect(res.status).toBe(200);
      expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
