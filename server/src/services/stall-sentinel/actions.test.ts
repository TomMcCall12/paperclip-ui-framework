import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createStallSentinelActions, type HeartbeatWakePort } from "./actions.js";
import { readStallSentinelConfig, STALL_SENTINEL_ACTOR_ID } from "./config.js";
import { resetStallSentinelHealthForTests } from "./health-state.js";
import { createStallSentinel, createStallSentinelStore } from "./index.js";
import { buildWatchedTrees, loadCompanySnapshot } from "./watch-units.js";
import { issueProgressAt } from "./progress.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping stall sentinel DB tests: ${support.reason ?? "unsupported environment"}`);
}

const MIN = 60_000;

describeDb("stall sentinel against a real database", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stall-sentinel-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    resetStallSentinelHealthForTests();
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(opts: { childOverrides?: Record<string, unknown> | null } = {}) {
    const companyId = randomUUID();
    const jarvisId = randomUUID();
    const engineerId = randomUUID();
    const rootId = randomUUID();
    const childId = randomUUID();
    const old = new Date(Date.now() - 30 * MIN);
    await db.insert(companies).values({
      id: companyId,
      name: "Stall fixture",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: jarvisId, companyId, name: "Jarvis", role: "ceo", status: "idle", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {} },
      { id: engineerId, companyId, name: "Engineer", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {} },
    ]);
    await db.insert(issues).values([
      { id: rootId, companyId, title: "Root goal", status: "in_progress", assigneeAgentId: jarvisId, createdAt: old, updatedAt: old, issueNumber: 1, identifier: "STL-1" },
      {
        id: childId,
        companyId,
        parentId: rootId,
        title: "S3: Build the alarm",
        status: "todo",
        assigneeAgentId: engineerId,
        assigneeAdapterOverrides: opts.childOverrides ?? null,
        createdAt: old,
        updatedAt: old,
        issueNumber: 2,
        identifier: "STL-2",
      },
    ]);
    return { companyId, jarvisId, engineerId, rootId, childId };
  }

  function recordingHeartbeat() {
    const wakes: Array<{ agentId: string; reason: string | null | undefined }> = [];
    const cancels: string[] = [];
    const port: HeartbeatWakePort = {
      async wakeup(agentId, opts) {
        wakes.push({ agentId, reason: opts.reason });
        return { id: randomUUID() };
      },
      async cancelRun(runId) {
        cancels.push(runId);
      },
    };
    return { port, wakes, cancels };
  }

  it("posts sentinel comments as system comments that wake nobody, even with a mention", async () => {
    const { rootId, jarvisId } = await seed();
    const actions = createStallSentinelActions({ db, heartbeat: null, send: null });
    await actions.comment(rootId, `Stall alarm: test. [@Jarvis](agent://${jarvisId})`);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, rootId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorType).toBe("system");
    const wakes = await db.select({ n: sql<number>`count(*)::int` }).from(agentWakeupRequests);
    expect(wakes[0]!.n).toBe(0);
  });

  it("loads a real tree; system comments do not count as progress and agent comments do", async () => {
    const { companyId, rootId, childId, engineerId } = await seed();
    const actions = createStallSentinelActions({ db, heartbeat: null, send: null });
    await actions.comment(childId, "Stall alarm: system note.");
    const now = new Date();
    let snapshot = await loadCompanySnapshot(
      { db, measureSilence: async () => null, listActiveRecovery: async () => new Set() },
      companyId,
      now,
      7 * 24 * 60 * MIN,
    );
    const trees = buildWatchedTrees(snapshot);
    expect(trees.map((t) => t.rootId)).toEqual([rootId]);
    expect([...trees[0]!.issueIds].sort()).toEqual([rootId, childId].sort());
    expect(snapshot.progress.latestByIssue.has(childId)).toBe(false);
    expect(issueProgressAt(snapshot, childId)!.getTime()).toBeLessThan(now.getTime() - 29 * MIN);

    await db.insert(issueComments).values({ companyId, issueId: childId, authorType: "agent", authorAgentId: engineerId, body: "Real work." });
    snapshot = await loadCompanySnapshot(
      { db, measureSilence: async () => null, listActiveRecovery: async () => new Set() },
      companyId,
      new Date(),
      7 * 24 * 60 * MIN,
    );
    expect(snapshot.progress.latestByIssue.has(childId)).toBe(true);
    expect(snapshot.progress.issuesWithWork.has(childId)).toBe(true);
  });

  it("alert_only: a full sweep writes comments and activity but changes no task, run or wake row", async () => {
    const { rootId } = await seed({ childOverrides: { adapterType: "codex_local" } });
    const before = await db.select().from(issues).orderBy(issues.id);
    const heartbeat = recordingHeartbeat();
    const telegrams: string[] = [];
    const sentinel = createStallSentinel({
      config: readStallSentinelConfig({ PAPERCLIP_STALL_SENTINEL_MODE: "alert_only" }),
      store: createStallSentinelStore(db, null),
      actions: createStallSentinelActions({
        db,
        heartbeat: heartbeat.port,
        send: async (_companyId, text) => {
          telegrams.push(text);
          return { sent: true };
        },
      }),
      fetchQuota: async () => [],
      resolveSchedulingSuppression: async () => ({ suppressed: false }),
      persistence: { readLastSweepAt: () => null, writeLastSweepAt: () => undefined },
    });
    await sentinel.sweep();

    const after = await db.select().from(issues).orderBy(issues.id);
    // Adding a comment touches the issue's updatedAt; comments are allowed in
    // alert-only mode. Every other column (status, assignee, overrides, ...) must match.
    const withoutTouch = (rows: typeof before) => rows.map(({ updatedAt: _touched, ...rest }) => rest);
    expect(withoutTouch(after)).toEqual(withoutTouch(before));
    expect(heartbeat.cancels).toEqual([]);
    expect(heartbeat.wakes.filter((w) => w.reason !== "stall_sentinel_reroute")).toEqual([]);
    const runs = await db.select({ n: sql<number>`count(*)::int` }).from(heartbeatRuns);
    expect(runs[0]!.n).toBe(0);
    const rows = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.actorType, "system"), eq(activityLog.actorId, STALL_SENTINEL_ACTOR_ID)));
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["stall_sentinel.would_heal", "stall_sentinel.alerted"]));
    const rootComments = await db.select().from(issueComments).where(eq(issueComments.issueId, rootId));
    expect(rootComments.length).toBeGreaterThan(0);
    expect(rootComments.every((c) => c.authorType === "system")).toBe(true);
    expect(telegrams.length).toBeGreaterThan(0);
  });

  it("on: the OpenAI-to-Claude rewrite passes the API's override validation and is logged with the old value", async () => {
    const { companyId, childId } = await seed({
      childOverrides: { adapterType: "codex_local", adapterConfig: { model: "gpt-6-sol", modelReasoningEffort: "xhigh" } },
    });
    const startedAt = new Date(Date.now() - 25 * 60 * MIN);
    await db.insert(activityLog).values([
      { companyId, actorType: "system", actorId: STALL_SENTINEL_ACTOR_ID, action: "stall_sentinel.rollout", entityType: "company", entityId: companyId, details: { phase: "started", startedAt: startedAt.toISOString() }, createdAt: startedAt },
      { companyId, actorType: "system", actorId: STALL_SENTINEL_ACTOR_ID, action: "stall_sentinel.rollout", entityType: "company", entityId: companyId, details: { phase: "self_repair_on" } },
    ]);
    const heartbeat = recordingHeartbeat();
    const sentinel = createStallSentinel({
      config: readStallSentinelConfig({ PAPERCLIP_STALL_SENTINEL_MODE: "on" }),
      store: createStallSentinelStore(db, null),
      actions: createStallSentinelActions({ db, heartbeat: heartbeat.port, send: async () => ({ sent: true }) }),
      fetchQuota: async () => [],
      resolveSchedulingSuppression: async () => ({ suppressed: false }),
      persistence: { readLastSweepAt: () => null, writeLastSweepAt: () => undefined },
    });
    await sentinel.sweep();
    const [child] = await db.select().from(issues).where(eq(issues.id, childId));
    expect(child!.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5-5", effort: "high" } });
    const healed = await db.select().from(activityLog).where(eq(activityLog.action, "stall_sentinel.healed"));
    expect(healed.find((row) => (row.details as Record<string, unknown>).action === "rewrite_to_claude")?.details).toMatchObject({
      previousOverrides: { adapterType: "codex_local", adapterConfig: { model: "gpt-6-sol" } },
    });
  });
});
