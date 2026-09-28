import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
}));

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";

type Actor = Record<string, unknown>;
const member: Actor = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
};

async function createApp(actor: Actor) {
  vi.resetModules();
  const [{ errorHandler }, { commandRoutes }, { createCommandDispatcher }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/commands.js"),
    import("../services/command-dispatcher.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", commandRoutes({} as any, createCommandDispatcher()));
  app.use(errorHandler);
  return app;
}

describe("command routes", () => {
  beforeEach(() => {
    mockIssueService.getById.mockReset();
    mockLogActivity.mockReset();
  });

  it("lists ui_chat commands for a company member", async () => {
    const res = await request(await createApp(member)).get("/api/companies/company-1/commands");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ version: 1, command: "echo", title: "Echo" })]);
  });

  it("executes /echo, scopes it to the issue's company, and logs activity without args", async () => {
    mockIssueService.getById.mockResolvedValue({ id: ISSUE_ID, companyId: "company-1" });
    const res = await request(await createApp(member))
      .post("/api/companies/company-1/commands/execute")
      .send({ command: "echo", args: "hello", issueId: ISSUE_ID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      command: "echo",
      result: { success: true, message: "Echo: hello", data: { echoed: "hello" } },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      actorType: "user",
      actorId: "user-1",
      action: "command.executed",
      entityType: "command",
      entityId: "echo",
      issueId: ISSUE_ID,
      details: { command: "echo", surface: "ui_chat", success: true },
    }));
  });

  it("rejects other companies, viewers, and cross-company agents before dispatch", async () => {
    const outsider = await createApp(member);
    expect((await request(outsider).get("/api/companies/company-2/commands")).status).toBe(403);
    expect(
      (await request(outsider).post("/api/companies/company-2/commands/execute").send({ command: "echo", args: "x" })).status,
    ).toBe(403);

    const viewer = await createApp({
      ...member,
      memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }],
    });
    expect((await request(viewer).get("/api/companies/company-1/commands")).status).toBe(200);
    expect(
      (await request(viewer).post("/api/companies/company-1/commands/execute").send({ command: "echo", args: "x" })).status,
    ).toBe(403);

    const agent = await createApp({ type: "agent", agentId: "agent-1", companyId: "company-2", source: "agent_key" });
    expect(
      (await request(agent).post("/api/companies/company-1/commands/execute").send({ command: "echo", args: "x" })).status,
    ).toBe(403);
    expect((await request(await createApp({ type: "none" })).get("/api/companies/company-1/commands")).status).toBe(401);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns 404 for cross-company issues and unknown commands, 400 for invalid bodies", async () => {
    const app = await createApp(member);
    mockIssueService.getById.mockResolvedValue({ id: ISSUE_ID, companyId: "company-2" });
    expect(
      (await request(app).post("/api/companies/company-1/commands/execute").send({ command: "echo", args: "x", issueId: ISSUE_ID })).status,
    ).toBe(404);
    expect(
      (await request(app).post("/api/companies/company-1/commands/execute").send({ command: "missing" })).status,
    ).toBe(404);
    expect(
      (await request(app).post("/api/companies/company-1/commands/execute").send({ command: "rm -rf /" })).status,
    ).toBe(400);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
