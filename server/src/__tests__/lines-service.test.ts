import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, approvals, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueApprovals, issues, lines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { lineService } from "../services/lines.js";
import { issueService } from "../services/issues.js";
import { lineNamingService } from "../services/line-naming.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { withBuiltInAgentMarker } from "../services/built-in-agent-metadata.js";
import { lineRoutes } from "../routes/lines.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("Line membership", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-lines-");
    db = createDb(temp.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.update(issues).set({ lineId: null });
    await db.delete(lines);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await temp?.cleanup(); });

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: id, issuePrefix: `L${id.slice(0, 6).toUpperCase()}` });
    return id;
  }
  async function issue(companyId: string, parentId?: string) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: "Work", parentId: parentId ?? null, status: "todo" });
    return id;
  }

  it("ensures one Line and includes existing descendants", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const child = await issue(companyId, root);
    const grandchild = await issue(companyId, child);
    const svc = lineService(db);
    const first = await svc.ensure(companyId, root, { type: "system" });
    const second = await svc.ensure(companyId, root, { type: "system" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.line.id).toBe(first.line.id);
    const rows = await db.select({ id: issues.id, lineId: issues.lineId }).from(issues);
    expect(rows.filter((row) => row.lineId === first.line.id).map((row) => row.id).sort())
      .toEqual([root, child, grandchild].sort());
  });

  it("rejects roots in another company", async () => {
    const first = await company();
    const second = await company();
    const root = await issue(first);
    await expect(lineService(db).ensure(second, root, { type: "system" })).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(lines).where(eq(lines.companyId, second))).toEqual([]);
  });

  it("new children inherit membership through the issue service", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    const created = await issueService(db).create(companyId, { title: "New task", parentId: root, status: "todo" });
    expect(created.lineId).toBe(line.id);
    const [stored] = await db.select({ lineId: issues.lineId }).from(issues).where(eq(issues.id, created.id));
    expect(stored.lineId).toBe(line.id);
  });

  it("rejects moving a grouped subtree out of its Line", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const child = await issue(companyId, root);
    const outside = await issue(companyId);
    await lineService(db).ensure(companyId, root, { type: "system" });
    await expect(issueService(db).update(child, { parentId: outside })).rejects.toMatchObject({ status: 409 });
    const [stored] = await db.select({ parentId: issues.parentId }).from(issues).where(eq(issues.id, child));
    expect(stored.parentId).toBe(root);
  });

  it("creates one hidden Claude naming task and binds its generation", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Summarizer", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" }, metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }) });
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    const first = await lineNamingService(db).start(companyId, line.id, { type: "system" });
    const second = await lineNamingService(db).start(companyId, line.id, { type: "system" });
    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    const [task] = await db.select().from(issues).where(eq(issues.id, first.namingIssueId!));
    expect(task.lineId).toBe(line.id);
    expect(task.hiddenAt).not.toBeNull();
    expect(task.assigneeAdapterOverrides).toEqual({ adapterType: "claude_local", adapterConfig: { model: "claude-haiku-4-5" } });
  });

  it("self-provisions a restricted naming agent instead of an existing powerful agent", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const powerfulAgentId = randomUUID();
    await db.insert(agents).values({ id: powerfulAgentId, companyId, name: "Jarvis", role: "general", status: "idle",
      adapterType: "claude_local", adapterConfig: { model: "claude-opus-5-5" }, permissions: { canCreateAgents: true, canCreateSkills: true } });
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(1);
    const first = await lineNamingService(db).start(companyId, line.id, { type: "system" });
    expect(first.queued).toBe(true);
    const [task] = await db.select().from(issues).where(eq(issues.id, first.namingIssueId!));
    expect(task.assigneeAgentId).not.toBe(powerfulAgentId);
    const [namer] = await db.select().from(agents).where(eq(agents.id, task.assigneeAgentId!));
    expect(namer).toMatchObject({ adapterType: "claude_local", permissions: { canCreateAgents: false, canCreateSkills: false } });
    expect(namer.adapterConfig).toMatchObject({ model: "claude-haiku-4-5" });
    const second = await builtInAgentService(db).get(companyId, "line-namer");
    expect(second.agentId).toBe(namer.id);
    expect(second.status).toBe("ready");
  });

  it("accepts only the current Claude task run and ignores a stale result", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    const { namingIssueId } = await lineNamingService(db).start(companyId, line.id, { type: "system" });
    const [task] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, namingIssueId!));
    const agentId = task.assigneeAgentId!;
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", startedAt: new Date(), contextSnapshot: { issueId: namingIssueId, lineNamingResolvedAdapterType: "codex_local", lineNamingResolvedModel: "claude-haiku-4-5" } });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, namingIssueId!));
    const input = { namingVersion: 1, namingIssueId: namingIssueId!, runId, name: "Customer Intake Flow" };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "agent", agentId, companyId, runId, source: "agent_jwt" }; next(); });
    app.use("/api", lineRoutes(db));
    app.use(errorHandler);
    const submit = () => request(app).post(`/api/lines/${line.id}/naming/result`).send(input);
    await expect(lineNamingService(db).result(companyId, line.id, input, { type: "agent", agentId, runId })).rejects.toMatchObject({ status: 403 });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: namingIssueId, lineNamingResolvedAdapterType: "claude_local", lineNamingResolvedModel: "claude-haiku-4-5" }, usageJson: { provider: "anthropic", model: "claude-haiku-4-5" } }).where(eq(heartbeatRuns.id, runId));
    expect((await submit()).status).toBe(403);
    expect((await lineService(db).get(companyId, line.id))?.name).toBeNull();
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1, eventType: "line.naming.provider_message",
      payload: { textSha256: createHash("sha256").update("Customer Intake Flow").digest("hex"), source: "claude_stream" } });
    const named = await submit();
    expect(named.status).toBe(200);
    expect(named.body.name).toBe("Customer Intake Flow");
    await expect(lineNamingService(db).result(companyId, line.id, { ...input, namingVersion: 0, name: "Wrong Older Name" }, { type: "agent", agentId, runId })).rejects.toMatchObject({ status: 409 });
  });

  it("archives only terminal visible work and reopens visibility when work resumes", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    await expect(lineService(db).archive(companyId, line.id, true, { type: "system" })).rejects.toMatchObject({ status: 409 });
    await issueService(db).update(root, { status: "done" });
    expect((await lineService(db).archive(companyId, line.id, true, { type: "system" })).archivedAt).not.toBeNull();
    await issueService(db).update(root, { status: "todo" });
    expect((await lineService(db).get(companyId, line.id))?.archivedAt).toBeNull();
  });

  it("does not disclose another company's Line through the route", async () => {
    const first = await company();
    const second = await company();
    const root = await issue(first);
    const { line } = await lineService(db).ensure(first, root, { type: "system" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", userId: "operator", companyIds: [second], memberships: [{ companyId: second, membershipRole: "owner", status: "active" }], source: "session", isInstanceAdmin: false }; next(); });
    app.use("/api", lineRoutes(db));
    app.use(errorHandler);
    const response = await request(app).get(`/api/lines/${line.id}`);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Line not found" });
  });

  it("denies Line totals when a restrictive actor cannot read one descendant", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const child = await issue(companyId, root);
    await issue(companyId, child);
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Restricted reviewer", role: "general", status: "idle", adapterType: "codex_local",
      permissions: { trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review",
        trustBoundary: { mode: "low_trust_review", companyId, issueIds: [root] } } } });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "agent", agentId, companyId, source: "agent_key" }; next(); });
    app.use("/api", lineRoutes(db));
    app.use(errorHandler);
    expect((await request(app).get(`/api/lines/${line.id}`)).status).toBe(403);
    const listed = await request(app).get(`/api/companies/${companyId}/lines`);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toEqual([]);
    expect(listed.body.nextCursor).toBeNull();
    const board = express();
    board.use((req, _res, next) => { (req as any).actor = { type: "board", userId: "operator", companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner", status: "active" }], source: "session", isInstanceAdmin: false }; next(); });
    board.use("/api", lineRoutes(db));
    board.use(errorHandler);
    expect((await request(board).get(`/api/lines/${line.id}`)).body.visibleIssueCount).toBe(3);
  });

  it("denies a Line with a hidden non-naming child to an agent", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const hidden = await issue(companyId, root);
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hidden));
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Member", role: "general", status: "idle", adapterType: "codex_local" });
    const app = express();
    app.use((req, _res, next) => { (req as any).actor = { type: "agent", agentId, companyId, source: "agent_key" }; next(); });
    app.use("/api", lineRoutes(db));
    app.use(errorHandler);
    expect((await request(app).get(`/api/lines/${line.id}`)).status).toBe(403);
  });

  it("lets an ordinary company agent list authorized Lines", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Member", role: "general", status: "idle", adapterType: "codex_local" });
    const app = express();
    app.use((req, _res, next) => { (req as any).actor = { type: "agent", agentId, companyId, source: "agent_key" }; next(); });
    app.use("/api", lineRoutes(db));
    app.use(errorHandler);
    const listed = await request(app).get(`/api/companies/${companyId}/lines`);
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((item: { id: string }) => item.id)).toEqual([line.id]);
  });

  it("shows pending approval destinations to the board without exposing them to agents", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    const approvalId = randomUUID();
    await db.insert(approvals).values({ id: approvalId, companyId, type: "request_board_approval", status: "pending", payload: {} });
    await db.insert(issueApprovals).values({ companyId, issueId: root, approvalId });
    expect((await lineService(db).get(companyId, line.id))?.pendingApprovals).toEqual([{ issueId: root, approvalId }]);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Member", role: "general", status: "idle", adapterType: "codex_local" });
    const app = express();
    app.use((req, _res, next) => { (req as any).actor = { type: "agent", agentId, companyId, source: "agent_key" }; next(); });
    app.use("/api", lineRoutes(db));
    app.use(errorHandler);
    expect((await request(app).get(`/api/lines/${line.id}`)).body.pendingApprovals).toEqual([]);
  });

  it("records malformed Claude output as a failed attempt without erasing the prior name", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    await db.update(lines).set({ name: "Earlier Valid Name", namingStatus: "ready" }).where(eq(lines.id, line.id));
    const { namingIssueId } = await lineNamingService(db).start(companyId, line.id, { type: "system" }, true);
    const [task] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, namingIssueId!));
    const agentId = task.assigneeAgentId!;
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", startedAt: new Date(), contextSnapshot: { issueId: namingIssueId, lineNamingResolvedAdapterType: "claude_local", lineNamingResolvedModel: "claude-haiku-4-5" } });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, namingIssueId!));
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1, eventType: "item.completed", sourceEventId: randomUUID(),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "commentary", text: "https://bad.example" } } } });
    await expect(lineNamingService(db).result(companyId, line.id, { namingVersion: 1, namingIssueId: namingIssueId!, runId, name: "https://bad.example" }, { type: "agent", agentId, runId })).rejects.toMatchObject({ status: 422 });
    const current = await lineService(db).get(companyId, line.id);
    expect(current?.name).toBe("Earlier Valid Name");
    expect(current?.namingStatus).toBe("failed");
  });

  it("serializes concurrent ensure and child creation", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const svc = lineService(db);
    const [first, second, child] = await Promise.all([
      svc.ensure(companyId, root, { type: "system" }),
      svc.ensure(companyId, root, { type: "system" }),
      issueService(db).create(companyId, { title: "Concurrent child", parentId: root, status: "todo" }),
    ]);
    expect(first.line.id).toBe(second.line.id);
    const [stored] = await db.select({ lineId: issues.lineId }).from(issues).where(eq(issues.id, child.id));
    expect(stored.lineId).toBe(first.line.id);
    expect((await db.select().from(lines)).length).toBe(1);
  });

  it("adopts only the exact approved subtree and records its approval", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const child = await issue(companyId, root);
    const approvalId = randomUUID();
    const manifestSha256 = "a".repeat(64);
    const inspected = await lineService(db).inspect(companyId, root);
    const evidence = { memberIssueIds: inspected.memberIssueIds, manifestSha256, approvalId };
    await db.insert(approvals).values({ id: approvalId, companyId, type: "request_board_approval", status: "pending", payload: { kind: "lines_adoption", manifestSha256 } });
    await expect(lineService(db).ensure(companyId, root, { type: "system" }, evidence)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(lines)).toHaveLength(0);
    await db.update(approvals).set({ status: "approved", decidedByUserId: "board-user", decidedAt: new Date() }).where(eq(approvals.id, approvalId));
    const addedAfterReview = await issue(companyId, root);
    await expect(lineService(db).ensure(companyId, root, { type: "system" }, evidence)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(lines)).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, addedAfterReview)))[0]?.lineId).toBeNull();
    await db.update(issues).set({ parentId: null }).where(eq(issues.id, addedAfterReview));
    const first = await lineService(db).ensure(companyId, root, { type: "system" }, evidence);
    const second = await lineService(db).ensure(companyId, root, { type: "system" }, evidence);
    expect(first.created).toBe(true);
    expect(second.line.id).toBe(first.line.id);
    const [event] = await db.select().from(activityLog).where(eq(activityLog.action, "line.created"));
    expect(event.details).toMatchObject({ manifestSha256, approvalId });
  });

  it("reconciles an unfinished naming task after restart", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Summarizer", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" }, metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }) });
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    const first = await lineNamingService(db).start(companyId, line.id, { type: "system" });
    await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId, agentId, status: "succeeded", startedAt: new Date(), finishedAt: new Date(), contextSnapshot: { issueId: first.namingIssueId } });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, first.namingIssueId!));
    await lineNamingService(db).reconcile();
    expect((await lineService(db).get(companyId, line.id))?.namingStatus).toBe("failed");
    await db.update(lines).set({ nextNamingAttemptAt: new Date(Date.now() - 1_000) }).where(eq(lines.id, line.id));
    const queued: string[] = [];
    await lineNamingService(db).reconcile(async (_company, taskId) => { queued.push(taskId); });
    expect(queued).toHaveLength(1);
    expect(queued[0]).not.toBe(first.namingIssueId);
    expect((await lineService(db).get(companyId, line.id))?.namingVersion).toBe(2);
  });

  it("does not consume attempts while pause or budget prevents a naming run", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Summarizer", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" }, metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }) });
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    const first = await lineNamingService(db).start(companyId, line.id, { type: "system" });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    await db.update(issues).set({ createdAt: new Date(Date.now() - 4 * 15 * 60_000) }).where(eq(issues.id, first.namingIssueId!));
    for (let window = 0; window < 4; window++) await lineNamingService(db).reconcile(async () => {});
    const current = await lineService(db).get(companyId, line.id);
    expect(current?.namingStatus).toBe("generating");
    expect(current?.namingAttempts).toBe(0);
    expect(current?.namingIssueId).toBe(first.namingIssueId);
    expect((await db.select().from(issues).where(eq(issues.originId, line.id))).length).toBe(1);
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: queuedRunId, companyId, agentId, status: "queued",
      contextSnapshot: { issueId: first.namingIssueId } });
    await lineNamingService(db).reconcile(async () => {});
    expect((await lineService(db).get(companyId, line.id))?.lastNamingErrorCode).toBe("waiting_for_dispatch");
    expect((await lineService(db).get(companyId, line.id))?.namingAttempts).toBe(0);
  });

  it("bounds retries after a started run stalls and rejects its late result", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Summarizer", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" }, metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }) });
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    const first = await lineNamingService(db).start(companyId, line.id, { type: "system" });
    const oldRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: oldRunId, companyId, agentId, status: "running", startedAt: new Date(Date.now() - 16 * 60_000),
      contextSnapshot: { issueId: first.namingIssueId, lineNamingResolvedAdapterType: "claude_local", lineNamingResolvedModel: "claude-haiku-4-5" } });
    await db.update(issues).set({ checkoutRunId: oldRunId }).where(eq(issues.id, first.namingIssueId!));
    await lineNamingService(db).reconcile();
    expect((await lineService(db).get(companyId, line.id))?.namingAttempts).toBe(1);
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, oldRunId));
    await db.update(lines).set({ nextNamingAttemptAt: new Date(Date.now() - 1_000) }).where(eq(lines.id, line.id));
    await lineNamingService(db).reconcile();
    expect((await lineService(db).get(companyId, line.id))?.namingVersion).toBe(2);
    await expect(lineNamingService(db).result(companyId, line.id, { namingVersion: 1, namingIssueId: first.namingIssueId!, runId: oldRunId, name: "Late Name" },
      { type: "agent", agentId, runId: oldRunId })).rejects.toMatchObject({ status: 409 });
  });

  it("keeps a prior name and parks failed regeneration until setup recovers", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    await db.update(lines).set({ name: "Earlier Valid Name", namingStatus: "ready" }).where(eq(lines.id, line.id));
    // Self-provision the built-in naming agent, then pause it to simulate it being
    // unavailable (e.g. mid-setup) — naming must park, not fall back to another agent.
    const provisioned = await builtInAgentService(db).ensure(companyId, "line-namer");
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, provisioned.agentId!));
    await Promise.all([lineNamingService(db).start(companyId, line.id, { type: "system" }, true),
      lineNamingService(db).start(companyId, line.id, { type: "system" }, true)]);
    const failed = await lineService(db).get(companyId, line.id);
    expect(failed).toMatchObject({ name: "Earlier Valid Name", namingStatus: "failed", namingAttempts: 0, lastNamingErrorCode: "summarizer_not_configured" });
    for (let minute = 0; minute < 3; minute++) await lineNamingService(db).reconcile();
    expect((await db.select().from(activityLog).where(eq(activityLog.action, "line.naming_failed"))).length).toBe(1);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, provisioned.agentId!));
    const [first, second] = await Promise.all([lineNamingService(db).start(companyId, line.id, { type: "system" }, true),
      lineNamingService(db).start(companyId, line.id, { type: "system" }, true)]);
    expect([first.queued, second.queued].filter(Boolean)).toHaveLength(1);
    expect((await lineService(db).get(companyId, line.id))?.name).toBe("Earlier Valid Name");
  });

  it("computes completion from visible tasks and excludes hidden naming work", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const hidden = await issue(companyId, root);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, root));
    await db.update(issues).set({ hiddenAt: new Date(), status: "todo" }).where(eq(issues.id, hidden));
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    const current = await lineService(db).get(companyId, line.id);
    expect(current).toMatchObject({ completionStatus: "completed", visibleIssueCount: 1, terminalIssueCount: 1 });
    const listed = await lineService(db).list(companyId, { status: "completed", limit: 25 });
    expect(listed.items.map((item) => item.id)).toEqual([line.id]);
  });
});
