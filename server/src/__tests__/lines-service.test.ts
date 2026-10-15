import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues, lines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { lineService } from "../services/lines.js";
import { issueService } from "../services/issues.js";
import { lineNamingService } from "../services/line-naming.js";
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
    await db.delete(heartbeatRuns);
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

  it("creates one hidden GPT naming task and binds its generation", async () => {
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
    expect(task.assigneeAdapterOverrides).toEqual({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.4-mini", modelReasoningEffort: "low" } });
  });

  it("accepts only the current OpenAI task run and ignores a stale result", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Summarizer", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" }, metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }) });
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    const { namingIssueId } = await lineNamingService(db).start(companyId, line.id, { type: "system" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", startedAt: new Date(), contextSnapshot: { issueId: namingIssueId, lineNamingResolvedAdapterType: "claude_local", lineNamingResolvedModel: "gpt-5.4-mini" } });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, namingIssueId!));
    const input = { namingVersion: 1, namingIssueId: namingIssueId!, runId, name: "Customer Intake Flow" };
    await expect(lineNamingService(db).result(companyId, line.id, input, { type: "agent", agentId, runId })).rejects.toMatchObject({ status: 403 });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: namingIssueId, lineNamingResolvedAdapterType: "codex_local", lineNamingResolvedModel: "gpt-5.4-mini" }, usageJson: { provider: "openai", model: "gpt-5.4-mini" } }).where(eq(heartbeatRuns.id, runId));
    const named = await lineNamingService(db).result(companyId, line.id, input, { type: "agent", agentId, runId });
    expect(named.name).toBe("Customer Intake Flow");
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

  it("records malformed GPT output as a failed attempt without erasing the prior name", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Summarizer", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" }, metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }) });
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    await db.update(lines).set({ name: "Earlier Valid Name", namingStatus: "ready" }).where(eq(lines.id, line.id));
    const { namingIssueId } = await lineNamingService(db).start(companyId, line.id, { type: "system" }, true);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", startedAt: new Date(), contextSnapshot: { issueId: namingIssueId, lineNamingResolvedAdapterType: "codex_local", lineNamingResolvedModel: "gpt-5.4-mini" } });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, namingIssueId!));
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

  it("reconciles an unfinished naming task after restart", async () => {
    const companyId = await company();
    const root = await issue(companyId);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Summarizer", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" }, metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }) });
    const { line } = await lineService(db).ensure(companyId, root, { type: "system" });
    const first = await lineNamingService(db).start(companyId, line.id, { type: "system" });
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
