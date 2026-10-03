import { beforeEach, describe, expect, it, vi } from "vitest";
import { agents } from "@paperclipai/db";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

type AgentRecord = { id: string; companyId: string; status: string; adapterType: string; adapterConfig: unknown };

const PENDING_AGENT: AgentRecord = {
  id: "agent-1",
  companyId: "company-1",
  status: "pending_approval",
  adapterType: "process",
  adapterConfig: {},
};

// A query-builder fake for the approval decision. Approval reads come from
// `selectResults` in order and agent reads from `agentRows`, each awaitable
// directly or after `.for("update")`. `transaction` runs its callback on the
// same fake and records whether it threw, standing in for a rollback.
function createDbStub(
  selectResults: ApprovalRecord[][],
  updateResults: ApprovalRecord[],
  agentRows: AgentRecord[] = [PENDING_AGENT],
) {
  const pendingSelectResults = [...selectResults];
  const lockedTables: unknown[] = [];
  const selectWhere = vi.fn((table: unknown) => {
    const rows = table === agents
      ? Promise.resolve(agentRows)
      : Promise.resolve(pendingSelectResults.shift() ?? []);
    return Object.assign(rows, {
      for: (mode: string) => {
        if (mode === "update") lockedTables.push(table);
        return rows;
      },
    });
  });
  const from = vi.fn((table: unknown) => ({ where: () => selectWhere(table) }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  const transactionOutcomes: Array<"committed" | "rolled_back"> = [];
  const db: Record<string, unknown> = { select, update };
  db.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    try {
      const result = await fn(db);
      transactionOutcomes.push("committed");
      return result;
    } catch (err) {
      transactionOutcomes.push("rolled_back");
      throw err;
    }
  });

  return {
    db,
    selectWhere,
    returning,
    update,
    lockedTables,
    transactionOutcomes,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue({ agent: { id: "agent-1" }, activated: true });
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.getById.mockResolvedValue(PENDING_AGENT);
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1", approved.payload);
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
    expect(dbStub.lockedTables).toEqual([expect.anything(), agents]);
    expect(dbStub.transactionOutcomes).toEqual(["committed"]);
  });

  it("creates the agent from payload when approval does not reference a pending agent", async () => {
    const approved = {
      ...createApproval("approved"),
      payload: {
        name: "New Agent",
        adapterConfig: {
          env: {
            API_KEY: {
              type: "secret_ref",
              secretId: "secret-1",
              version: "latest",
            },
          },
        },
      },
    };
    const dbStub = createDbStub([[{ ...createApproval("pending"), payload: approved.payload }]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: approved.payload.adapterConfig,
      }),
    );
    // The legacy create runs inside the decision transaction, before commit.
    expect(dbStub.transactionOutcomes).toEqual(["committed"]);
    expect(mockNotifyHireApproved).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: "agent-1", source: "approval" }),
    );
  });

  describe("named agent and Hermes checks at the decision", () => {
    const OWN_SECRET_ID = "22222222-2222-4222-8222-222222222222";
    const FOREIGN_SECRET_ID = "33333333-3333-4333-8333-333333333333";
    const SAVED_URL = "https://gateway.example.test/v1";
    const HERMES_AGENT: AgentRecord = {
      ...PENDING_AGENT,
      adapterType: "hermes_gateway",
      adapterConfig: { apiBaseUrl: SAVED_URL, apiKey: { type: "secret_ref", secretId: OWN_SECRET_ID } },
    };

    function pendingWith(payload: Record<string, unknown>, status = "pending"): ApprovalRecord {
      return { ...createApproval(status), payload };
    }

    async function expectRejectedDecision(
      dbStub: ReturnType<typeof createDbStub>,
      code: string,
    ) {
      const svc = approvalService(dbStub.db as any);
      const err = await svc.approve("approval-1", "board", "ship it").then(
        () => null,
        (error: unknown) => error as { status?: number; details?: unknown; message?: string },
      );
      expect(err).toMatchObject({ status: 422, details: { code } });
      expect(JSON.stringify({ message: err?.message, details: err?.details })).not.toMatch(
        new RegExp(`${OWN_SECRET_ID}|${FOREIGN_SECRET_ID}|agent-1`),
      );
      expect(dbStub.update).not.toHaveBeenCalled();
      expect(dbStub.transactionOutcomes).toEqual(["rolled_back"]);
      expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
      expect(mockAgentService.create).not.toHaveBeenCalled();
      expect(mockNotifyHireApproved).not.toHaveBeenCalled();
    }

    for (const [label, agentRows] of [
      ["missing", []],
      ["another company's", [{ ...PENDING_AGENT, companyId: "company-2" }]],
      ["already active", [{ ...PENDING_AGENT, status: "idle" }]],
    ] as const) {
      for (const [payloadLabel, payload] of [
        ["adapter-type-omitted", { agentId: "agent-1" }],
        ["non-Hermes", { agentId: "agent-1", adapterType: "process" }],
        ["Hermes", { agentId: "agent-1", adapterType: "hermes_gateway" }],
      ] as const) {
        it(`keeps a ${payloadLabel} approval naming a ${label} agent open`, async () => {
          const dbStub = createDbStub([[pendingWith({ ...payload })]], [], [...agentRows]);
          await expectRejectedDecision(dbStub, "hire_approval_agent_not_pending");
        });
      }
    }

    it("rejects an old approval that borrows another stored secret for the pending Hermes agent", async () => {
      const dbStub = createDbStub(
        [[pendingWith({
          agentId: "agent-1",
          adapterType: "hermes_gateway",
          adapterConfig: { apiBaseUrl: SAVED_URL, token: { type: "secret_ref", secretId: FOREIGN_SECRET_ID } },
        }, "revision_requested")]],
        [],
        [HERMES_AGENT],
      );
      await expectRejectedDecision(dbStub, "hermes_gateway_unbound_secret_ref");
    });

    it("rejects an old approval that moves the pending Hermes agent's own key to the token alias", async () => {
      const dbStub = createDbStub(
        [[pendingWith({
          agentId: "agent-1",
          adapterType: "hermes_gateway",
          adapterConfig: { apiBaseUrl: SAVED_URL, token: { type: "secret_ref", secretId: OWN_SECRET_ID } },
        })]],
        [],
        [HERMES_AGENT],
      );
      await expectRejectedDecision(dbStub, "hermes_gateway_unbound_secret_ref");
    });

    it("rejects an old approval that sends the saved key to a new gateway URL", async () => {
      const dbStub = createDbStub(
        [[pendingWith({
          agentId: "agent-1",
          adapterType: "hermes_gateway",
          adapterConfig: {
            apiBaseUrl: "https://collector.example.test/v1",
            apiKey: { type: "secret_ref", secretId: OWN_SECRET_ID },
          },
        })]],
        [],
        [HERMES_AGENT],
      );
      await expectRejectedDecision(dbStub, "hermes_gateway_credential_rebind_required");
    });

    it("rejects an old no-agent Hermes approval holding a stored secret", async () => {
      const dbStub = createDbStub(
        [[pendingWith({
          name: "Gateway",
          adapterType: "hermes_gateway",
          adapterConfig: { apiBaseUrl: SAVED_URL, apiKey: { type: "secret_ref", secretId: OWN_SECRET_ID } },
        })]],
        [],
      );
      await expectRejectedDecision(dbStub, "hermes_gateway_unbound_secret_ref");
    });

    it("approves an old no-agent Hermes approval holding a typed plain key inside the transaction", async () => {
      const payload = {
        name: "Gateway",
        adapterType: "hermes_gateway",
        adapterConfig: { apiBaseUrl: SAVED_URL, apiKey: "synthetic-plain-key" },
      };
      const dbStub = createDbStub([[pendingWith(payload)]], [{ ...createApproval("approved"), payload }]);

      const result = await approvalService(dbStub.db as any).approve("approval-1", "board", null);

      expect(result.applied).toBe(true);
      expect(mockAgentService.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ adapterType: "hermes_gateway", adapterConfig: payload.adapterConfig }),
      );
      expect(dbStub.transactionOutcomes).toEqual(["committed"]);
    });

    it("rolls the approval back when the legacy agent create fails", async () => {
      mockAgentService.create.mockRejectedValueOnce(new Error("create failed"));
      const payload = { name: "Process", adapterType: "process" };
      const dbStub = createDbStub([[pendingWith(payload)]], [{ ...createApproval("approved"), payload }]);

      await expect(approvalService(dbStub.db as any).approve("approval-1", "board", null)).rejects.toThrow(
        "create failed",
      );
      expect(dbStub.transactionOutcomes).toEqual(["rolled_back"]);
      expect(mockNotifyHireApproved).not.toHaveBeenCalled();
    });

    it("rolls the approval back when the pending agent is not activated", async () => {
      mockAgentService.activatePendingApproval.mockResolvedValueOnce({ agent: PENDING_AGENT, activated: false });
      const dbStub = createDbStub([[createApproval("pending")]], [createApproval("approved")]);

      await expect(approvalService(dbStub.db as any).approve("approval-1", "board", null)).rejects.toMatchObject({
        status: 422,
        details: { code: "hire_approval_agent_not_pending" },
      });
      expect(dbStub.transactionOutcomes).toEqual(["rolled_back"]);
      expect(mockNotifyHireApproved).not.toHaveBeenCalled();
    });

    it("treats a repeated approve of an already approved Hermes hire as a no-op without rechecking", async () => {
      const approved = pendingWith({
        agentId: "agent-1",
        adapterType: "hermes_gateway",
        adapterConfig: { apiBaseUrl: SAVED_URL, apiKey: { type: "secret_ref", secretId: OWN_SECRET_ID } },
      }, "approved");
      const dbStub = createDbStub([[approved]], [], [{ ...HERMES_AGENT, status: "idle" }]);

      const result = await approvalService(dbStub.db as any).approve("approval-1", "board", null);

      expect(result).toEqual({ approval: approved, applied: false });
      expect(dbStub.update).not.toHaveBeenCalled();
      expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    });

    it("does not terminate another company's agent when rejecting", async () => {
      mockAgentService.getById.mockResolvedValue({ ...PENDING_AGENT, companyId: "company-2" });
      const dbStub = createDbStub([[createApproval("pending")]], [createApproval("rejected")]);

      const result = await approvalService(dbStub.db as any).reject("approval-1", "board", null);

      expect(result.applied).toBe(true);
      expect(mockAgentService.terminate).not.toHaveBeenCalled();
    });

    it("still terminates this company's pending agent when rejecting", async () => {
      const dbStub = createDbStub([[createApproval("pending")]], [createApproval("rejected")]);

      await approvalService(dbStub.db as any).reject("approval-1", "board", null);

      expect(mockAgentService.terminate).toHaveBeenCalledWith("agent-1");
    });
  });
});

describe("approvalService conditional revision transitions", () => {
  it("refuses a resubmit once the approval left revision_requested", async () => {
    const dbStub = createDbStub([[createApproval("revision_requested")]], []);
    await expect(approvalService(dbStub.db as any).resubmit("approval-1", { agentId: "agent-1" })).rejects.toMatchObject({
      status: 422,
    });
    expect(dbStub.update).toHaveBeenCalledTimes(1);
  });

  it("refuses a revision request once the approval left pending", async () => {
    const dbStub = createDbStub([[createApproval("pending")]], []);
    await expect(approvalService(dbStub.db as any).requestRevision("approval-1", "board", null)).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe("approvalService.findOpenHireApprovalForAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the open hire approval the company/type/status/agentId filter yields", async () => {
    const match = {
      ...createApproval("pending"),
      id: "approval-match",
      payload: { agentId: "agent-1" },
    };
    // The company, type, open-status and payload->>'agentId' predicates run in
    // SQL, so the DB hands back only the matching row.
    const dbStub = createDbStub([[match]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result?.id).toBe("approval-match");
    expect(dbStub.selectWhere).toHaveBeenCalledTimes(1);
  });

  it("returns null when no open approval matches the agent", async () => {
    const dbStub = createDbStub([[]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result).toBeNull();
  });
});
