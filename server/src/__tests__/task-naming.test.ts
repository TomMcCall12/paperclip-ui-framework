import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueTitleNamings,
  issues,
  lines,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const wakeups = vi.hoisted(() => [] as Array<{ issueId: string; reason: string }>);
vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(async (input: { issue: { id: string }; reason: string }) => {
    wakeups.push({ issueId: input.issue.id, reason: input.reason });
  }),
}));

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

const DESCRIPTION = "Please fix the login bug that only happens on mobile Safari.";

suite("AI task naming", () => {
  let db!: Db;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let issueRoutes!: typeof import("../routes/issues.js").issueRoutes;
  let taskNamingRoutes!: typeof import("../routes/task-naming.js").taskNamingRoutes;
  let taskNamingService!: typeof import("../services/task-naming.js").taskNamingService;
  let lineService!: typeof import("../services/lines.js").lineService;
  let errorHandler!: typeof import("../middleware/index.js").errorHandler;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-task-naming-");
    db = createDb(temp.connectionString);
    ({ issueRoutes } = await import("../routes/issues.js"));
    ({ taskNamingRoutes } = await import("../routes/task-naming.js"));
    ({ taskNamingService } = await import("../services/task-naming.js"));
    ({ lineService } = await import("../services/lines.js"));
    ({ errorHandler } = await import("../middleware/index.js"));
  }, 60_000);
  afterEach(async () => {
    wakeups.length = 0;
    await db.delete(issueTitleNamings);
    await db.update(issues).set({ lineId: null });
    await db.delete(lines);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await temp?.cleanup(); });

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: id, issuePrefix: `T${id.replaceAll("-", "").slice(0, 6).toUpperCase()}` });
    return id;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return { type: "board", userId: "board-user", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true } as Express.Request["actor"];
  }

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use("/api", taskNamingRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function createDerived(companyId: string, body: Record<string, unknown> = {}) {
    const response = await request(appFor(boardActor(companyId))).post(`/api/companies/${companyId}/issues`)
      .send({ title: "Please fix the login bug that only happens on mobile Safari.", description: DESCRIPTION, titleSource: "derived", status: "todo", ...body });
    expect(response.status).toBe(201);
    return response.body as { id: string; title: string; titleSource: string };
  }

  async function namingRow(issueId: string) {
    const [row] = await db.select().from(issueTitleNamings).where(eq(issueTitleNamings.issueId, issueId));
    return row;
  }

  /** Simulates the Line Namer's running Claude run that sent `text` as a standalone message. */
  async function namerRun(companyId: string, namingIssueId: string, text: string) {
    const [task] = await db.select().from(issues).where(eq(issues.id, namingIssueId));
    const agentId = task.assigneeAgentId!;
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", startedAt: new Date(),
      contextSnapshot: { issueId: namingIssueId, lineNamingResolvedAdapterType: "claude_local", lineNamingResolvedModel: "claude-haiku-4-5" },
      usageJson: { provider: "anthropic", model: "claude-haiku-4-5" } });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, namingIssueId));
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1, eventType: "line.naming.provider_message",
      payload: { textSha256: createHash("sha256").update(text.trim()).digest("hex"), source: "claude_stream_json" } });
    const app = appFor({ type: "agent", agentId, companyId, runId, source: "agent_jwt" } as Express.Request["actor"]);
    return { agentId, runId, app };
  }

  it("starts exactly one hidden, parentless Line Namer task for a derived create", async () => {
    const companyId = await company();
    const created = await createDerived(companyId);
    expect(created.titleSource).toBe("derived");
    const namingTasks = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_naming")));
    expect(namingTasks).toHaveLength(1);
    const [task] = namingTasks;
    expect(task).toMatchObject({ parentId: null, originId: created.id, titleSource: "explicit", lineId: null });
    expect(task.hiddenAt).not.toBeNull();
    expect(task.title).toMatch(/^Name task .+ \(generation 1\)$/);
    expect(task.assigneeAdapterOverrides).toEqual({ adapterType: "claude_local", adapterConfig: { model: "claude-haiku-4-5" } });
    expect(task.description).toContain("/title-naming/result");
    const [namer] = await db.select().from(agents).where(eq(agents.id, task.assigneeAgentId!));
    expect(namer).toMatchObject({ name: "Line Namer", adapterType: "claude_local" });
    expect(namer.adapterConfig).toMatchObject({ model: "claude-haiku-4-5" });
    expect(await namingRow(created.id)).toMatchObject({ status: "generating", namingVersion: 1, namingIssueId: task.id, titleAtStart: created.title });
    expect(wakeups.filter((w) => w.issueId === task.id)).toEqual([{ issueId: task.id, reason: "task_naming_requested" }]);
  });

  it("renames on a valid result, sets titleSource ai and logs issue.title_named", async () => {
    const companyId = await company();
    const created = await createDerived(companyId);
    const row = await namingRow(created.id);
    const { app, runId, agentId } = await namerRun(companyId, row.namingIssueId!, "Fix mobile Safari login bug");
    const response = await request(app).post(`/api/issues/${created.id}/title-naming/result`)
      .send({ namingVersion: 1, namingIssueId: row.namingIssueId, runId, title: "Fix mobile Safari login bug" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ title: "Fix mobile Safari login bug", titleSource: "ai" });
    const [stored] = await db.select().from(issues).where(eq(issues.id, created.id));
    expect(stored).toMatchObject({ title: "Fix mobile Safari login bug", titleSource: "ai" });
    expect(await namingRow(created.id)).toMatchObject({ status: "ready", namingRunId: runId, model: "claude-haiku-4-5", attempts: 1 });
    const [named] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, created.id), eq(activityLog.action, "issue.title_named")));
    expect(named).toMatchObject({ actorType: "agent", actorId: agentId, agentId, runId });
    expect(named.details).toMatchObject({ fromTitle: created.title, toTitle: "Fix mobile Safari login bug", model: "claude-haiku-4-5", namingIssueId: row.namingIssueId });
    const updatedEvents = await db.select().from(activityLog).where(and(eq(activityLog.entityId, created.id), eq(activityLog.action, "issue.updated")));
    expect(updatedEvents.some((event) => (event.details as Record<string, unknown>)?.source === "task_naming")).toBe(true);
  });

  it("keeps a title edited before the result and answers the result with 409", async () => {
    const companyId = await company();
    const created = await createDerived(companyId);
    const row = await namingRow(created.id);
    const edit = await request(appFor(boardActor(companyId))).patch(`/api/issues/${created.id}`).send({ title: "My own title" });
    expect(edit.status).toBe(200);
    const [stored] = await db.select().from(issues).where(eq(issues.id, created.id));
    expect(stored).toMatchObject({ title: "My own title", titleSource: "explicit" });
    expect(await namingRow(created.id)).toMatchObject({ status: "skipped", lastErrorCode: "title_changed" });
    const [namingTask] = await db.select().from(issues).where(eq(issues.id, row.namingIssueId!));
    expect(namingTask.status).toBe("cancelled");
    const { app, runId } = await namerRun(companyId, row.namingIssueId!, "Fix mobile Safari login bug");
    const response = await request(app).post(`/api/issues/${created.id}/title-naming/result`)
      .send({ namingVersion: 1, namingIssueId: row.namingIssueId, runId, title: "Fix mobile Safari login bug" });
    expect(response.status).toBe(409);
    const [after] = await db.select().from(issues).where(eq(issues.id, created.id));
    expect(after).toMatchObject({ title: "My own title", titleSource: "explicit" });
  });

  it("rejects a title change that races the result inside the guard with 409 title_changed", async () => {
    const companyId = await company();
    const created = await createDerived(companyId);
    const row = await namingRow(created.id);
    // A direct write (no update path) leaves the naming generating; the result guard still catches it.
    await db.update(issues).set({ title: "Changed elsewhere" }).where(eq(issues.id, created.id));
    const { app, runId } = await namerRun(companyId, row.namingIssueId!, "Fix mobile Safari login bug");
    const response = await request(app).post(`/api/issues/${created.id}/title-naming/result`)
      .send({ namingVersion: 1, namingIssueId: row.namingIssueId, runId, title: "Fix mobile Safari login bug" });
    expect(response.status).toBe(409);
    expect(await namingRow(created.id)).toMatchObject({ status: "skipped", lastErrorCode: "title_changed" });
    const [after] = await db.select().from(issues).where(eq(issues.id, created.id));
    expect(after.title).toBe("Changed elsewhere");
  });

  it("answers a stale generation with 409", async () => {
    const companyId = await company();
    const created = await createDerived(companyId);
    const row = await namingRow(created.id);
    const { app, runId } = await namerRun(companyId, row.namingIssueId!, "Fix mobile Safari login bug");
    const stale = await request(app).post(`/api/issues/${created.id}/title-naming/result`)
      .send({ namingVersion: 0, namingIssueId: row.namingIssueId, runId, title: "Fix mobile Safari login bug" });
    expect(stale.status).toBe(409);
    const wrongTask = await request(app).post(`/api/issues/${created.id}/title-naming/result`)
      .send({ namingVersion: 1, namingIssueId: randomUUID(), runId, title: "Fix mobile Safari login bug" });
    expect(wrongTask.status).toBe(409);
  });

  it("refuses a wrong-company agent (404) and a non-naming agent (403)", async () => {
    const companyId = await company();
    const otherCompanyId = await company();
    const created = await createDerived(companyId);
    const row = await namingRow(created.id);
    const { runId } = await namerRun(companyId, row.namingIssueId!, "Fix mobile Safari login bug");
    const body = { namingVersion: 1, namingIssueId: row.namingIssueId, runId, title: "Fix mobile Safari login bug" };
    const outsiderId = randomUUID();
    await db.insert(agents).values({ id: outsiderId, companyId: otherCompanyId, name: "Outsider", role: "general", status: "idle", adapterType: "claude_local", adapterConfig: { model: "claude-haiku-4-5" } });
    const foreign = await request(appFor({ type: "agent", agentId: outsiderId, companyId: otherCompanyId, runId, source: "agent_jwt" } as Express.Request["actor"]))
      .post(`/api/issues/${created.id}/title-naming/result`).send(body);
    expect(foreign.status).toBe(404);
    const memberId = randomUUID();
    await db.insert(agents).values({ id: memberId, companyId, name: "Member", role: "general", status: "idle", adapterType: "claude_local", adapterConfig: { model: "claude-haiku-4-5" } });
    const member = await request(appFor({ type: "agent", agentId: memberId, companyId, runId, source: "agent_jwt" } as Express.Request["actor"]))
      .post(`/api/issues/${created.id}/title-naming/result`).send(body);
    expect(member.status).toBe(403);
    const apiKeyAgent = await request(appFor({ type: "agent", agentId: memberId, companyId, runId, source: "agent_key" } as Express.Request["actor"]))
      .post(`/api/issues/${created.id}/title-naming/result`).send(body);
    expect(apiKeyAgent.status).toBe(403);
    const [stored] = await db.select().from(issues).where(eq(issues.id, created.id));
    expect(stored.titleSource).toBe("derived");
  });

  it("fails invalid output with backoff and keeps the derived title", async () => {
    const companyId = await company();
    const created = await createDerived(companyId);
    const row = await namingRow(created.id);
    const { app, runId } = await namerRun(companyId, row.namingIssueId!, "Visit https://example.com now");
    const before = Date.now();
    const response = await request(app).post(`/api/issues/${created.id}/title-naming/result`)
      .send({ namingVersion: 1, namingIssueId: row.namingIssueId, runId, title: "Visit https://example.com now" });
    expect(response.status).toBe(422);
    const failed = await namingRow(created.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 1, lastErrorCode: "invalid_output" });
    const delay = failed.nextAttemptAt!.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(55_000);
    expect(delay).toBeLessThanOrEqual(65_000);
    const [stored] = await db.select().from(issues).where(eq(issues.id, created.id));
    expect(stored).toMatchObject({ title: created.title, titleSource: "derived" });
  });

  it("starts nothing for an explicit-title create", async () => {
    const companyId = await company();
    const response = await request(appFor(boardActor(companyId))).post(`/api/companies/${companyId}/issues`)
      .send({ title: "Typed title", description: DESCRIPTION, status: "todo" });
    expect(response.status).toBe(201);
    expect(response.body.titleSource).toBe("explicit");
    expect(await db.select().from(issues).where(eq(issues.originKind, "task_naming"))).toHaveLength(0);
    expect(await db.select().from(issueTitleNamings)).toHaveLength(0);
  });

  it("rejects a client-sent ai title source", async () => {
    const companyId = await company();
    const response = await request(appFor(boardActor(companyId))).post(`/api/companies/${companyId}/issues`)
      .send({ title: "Typed title", description: DESCRIPTION, titleSource: "ai", status: "todo" });
    expect(response.status).toBe(400);
  });

  it("never starts naming for a naming task", async () => {
    const companyId = await company();
    const created = await createDerived(companyId);
    const row = await namingRow(created.id);
    await db.update(issues).set({ titleSource: "derived" }).where(eq(issues.id, row.namingIssueId!));
    const result = await taskNamingService(db).start(companyId, row.namingIssueId!, { type: "system" });
    expect(result.queued).toBe(false);
    expect(await namingRow(row.namingIssueId!)).toBeUndefined();
    expect(await db.select().from(issues).where(eq(issues.originKind, "task_naming"))).toHaveLength(1);
  });

  it("skips the 21st start in an hour as rate limited and short descriptions as too short", async () => {
    const companyId = await company();
    const svc = taskNamingService(db);
    for (let i = 0; i < 20; i += 1) {
      const target = randomUUID();
      await db.insert(issues).values({ id: target, companyId, title: `Derived ${i}`, description: DESCRIPTION, titleSource: "derived", status: "todo" });
      expect((await svc.start(companyId, target, { type: "system" })).queued).toBe(true);
    }
    const created = await createDerived(companyId);
    expect(await namingRow(created.id)).toMatchObject({ status: "skipped", lastErrorCode: "rate_limited" });
    expect(await db.select().from(issues).where(eq(issues.originKind, "task_naming"))).toHaveLength(20);

    const otherCompanyId = await company();
    const short = await createDerived(otherCompanyId, { title: "Fix login", description: "Fix login" });
    expect(await namingRow(short.id)).toMatchObject({ status: "skipped", lastErrorCode: "too_short" });
  });

  it("keeps the hidden naming task out of the children list, Line members and the board issue list", async () => {
    const companyId = await company();
    const parentId = randomUUID();
    await db.insert(issues).values({ id: parentId, companyId, title: "Parent", status: "todo" });
    const { line } = await lineService(db).ensure(companyId, parentId, { type: "system" });
    const created = await createDerived(companyId, { parentId });
    const row = await namingRow(created.id);
    const namingIssueId = row.namingIssueId!;
    const board = appFor(boardActor(companyId));
    const listed = await request(board).get(`/api/companies/${companyId}/issues`);
    expect(listed.status).toBe(200);
    const listIds = (Array.isArray(listed.body) ? listed.body : listed.body.items).map((item: { id: string }) => item.id);
    expect(listIds).toContain(created.id);
    expect(listIds).not.toContain(namingIssueId);
    const children = await request(board).get(`/api/companies/${companyId}/issues?parentId=${parentId}`);
    const childIds = (Array.isArray(children.body) ? children.body : children.body.items).map((item: { id: string }) => item.id);
    expect(childIds).toContain(created.id);
    expect(childIds).not.toContain(namingIssueId);
    const [namingTask] = await db.select().from(issues).where(eq(issues.id, namingIssueId));
    expect(namingTask.lineId).toBeNull();
    const members = await db.select({ id: issues.id }).from(issues).where(eq(issues.lineId, line.id));
    expect(members.map((member) => member.id)).not.toContain(namingIssueId);
  });

  it("lets only the board retry naming, even on an explicit title, and the result sets ai", async () => {
    const companyId = await company();
    const response = await request(appFor(boardActor(companyId))).post(`/api/companies/${companyId}/issues`)
      .send({ title: "Typed title", description: DESCRIPTION, status: "todo" });
    const issueId = response.body.id as string;
    const memberId = randomUUID();
    await db.insert(agents).values({ id: memberId, companyId, name: "Member", role: "general", status: "idle", adapterType: "claude_local", adapterConfig: { model: "claude-haiku-4-5" } });
    const agentRetry = await request(appFor({ type: "agent", agentId: memberId, companyId, source: "agent_key" } as Express.Request["actor"]))
      .post(`/api/issues/${issueId}/title-naming/retry`).send({});
    expect(agentRetry.status).toBe(403);
    const retry = await request(appFor(boardActor(companyId))).post(`/api/issues/${issueId}/title-naming/retry`).send({});
    expect(retry.status).toBe(202);
    expect(retry.body.queued).toBe(true);
    const [retried] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.title_naming_retried")));
    expect(retried).toBeTruthy();
    const row = await namingRow(issueId);
    const { app, runId } = await namerRun(companyId, row.namingIssueId!, "Fix mobile Safari login bug");
    const named = await request(app).post(`/api/issues/${issueId}/title-naming/result`)
      .send({ namingVersion: row.namingVersion, namingIssueId: row.namingIssueId, runId, title: "Fix mobile Safari login bug" });
    expect(named.status).toBe(200);
    expect(named.body).toMatchObject({ title: "Fix mobile Safari login bug", titleSource: "ai" });
  });
});
