/**
 * Stall sentinel wakes and queries against the real server and schema (embedded
 * Postgres). Turned from the S8 review reproductions (TOM-723): a sentinel wake
 * aimed at a task that still has open blockers must start a run, in the same
 * bounded triage mode as a comment wake; no other automatic wake may.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { loadCompanySnapshot } from "../services/stall-sentinel/watch-units.js";
import { loadIssueProgressEvents } from "../services/stall-sentinel/progress.js";
import { loadMemoryRows, loadRolloutState } from "../services/stall-sentinel/dedupe.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    summary: "Stall sentinel test run.", provider: "test", model: "test-model",
  })),
);
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

describeDb("stall sentinel wakes and queries on the real server", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stall-sentinel-live-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    const runIds = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).then((rows) => rows.map((r) => r.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    runningProcesses.clear();
    await db.delete(environmentLeases);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const jarvisId = randomUUID();
    const parentId = randomUUID();
    const doneChildId = randomUUID();
    const openChildId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: jarvisId, companyId, name: "Jarvis", role: "ceo", status: "active",
      adapterType: "claude_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    });
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Make silent stalls impossible", status: "blocked", priority: "high", assigneeAgentId: jarvisId, responsibleUserId: "tom" },
      { id: doneChildId, companyId, parentId, title: "S7: Integrate", status: "done", priority: "high", responsibleUserId: "tom" },
      { id: openChildId, companyId, parentId, title: "S8: Review", status: "todo", priority: "high", responsibleUserId: "tom" },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: doneChildId, relatedIssueId: parentId, type: "blocks" },
      { companyId, issueId: openChildId, relatedIssueId: parentId, type: "blocks" },
    ]);
    return { companyId, jarvisId, parentId, doneChildId, openChildId };
  }

  // Exactly what actions.ts wake() sends to heartbeat.wakeup for a heal or a reroute.
  function sentinelWake(agentId: string, issueId: string, reason: string, payload: Record<string, unknown> = {}) {
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason,
      payload: { ...payload, issueId },
      idempotencyKey: `stall-sentinel:test:${reason}:${issueId}`,
      requestedByActorType: "system",
      requestedByActorId: "stall-sentinel",
      contextSnapshot: { issueId, wakeReason: reason },
    });
  }

  it.each([
    ["checkpoint heal (K, design row 8)", "stall_sentinel_checkpoint_done"],
    ["cancelled-blocker heal (C, design row 7)", "stall_sentinel_cancelled_blocker"],
    ["coordinator reroute after an alert ('Jarvis has been asked')", "stall_sentinel_reroute"],
  ])("%s: the wake on a dependency-blocked parent starts a run in triage mode", async (_name, reason) => {
    const { jarvisId, parentId, doneChildId } = await seed();
    const result = await sentinelWake(jarvisId, parentId, reason, { finishedChildIssueId: doneChildId });
    expect(result).not.toBeNull();
    const wakes = await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, jarvisId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ reason });
    expect(wakes[0]!.status).not.toBe("skipped");
    const runs = await db.select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns);
    expect(runs).toHaveLength(1);
    // Same bounded mode as a comment wake: the run knows the deliverable is still blocked.
    expect(runs[0]!.contextSnapshot).toMatchObject({ dependencyBlockedInteraction: true, unresolvedBlockerCount: 1 });
    // Triage does not unblock anything.
    const [parent] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, parentId));
    expect(parent!.status).toBe("blocked");
  });

  it.each([
    "stall_sentinel_requeue",
    "stall_sentinel_resume",
    "stall_sentinel_blocked_without_blocker",
    "stall_sentinel_provider_reset",
    "stall_sentinel_provider_rewrite",
  ])("other automatic wake %s is still skipped on a dependency-blocked parent", async (reason) => {
    const { jarvisId, parentId } = await seed();
    const result = await sentinelWake(jarvisId, parentId, reason);
    expect(result).toBeNull();
    const wakes = await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, jarvisId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "skipped", reason: "issue_dependencies_blocked" });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(0);
  });

  it("control: a human-comment wake on the same blocked parent does start a run", async () => {
    const { companyId, jarvisId, parentId } = await seed();
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: parentId, authorType: "user", body: "Please look." }).returning();
    const result = await heartbeat.wakeup(jarvisId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: parentId, commentId: comment!.id },
      contextSnapshot: { issueId: parentId, wakeReason: "issue_commented" },
    });
    expect(result).not.toBeNull();
  });

  it("loadCompanySnapshot and loadIssueProgressEvents run on the real schema and see agent progress", async () => {
    const { companyId, jarvisId, parentId, openChildId } = await seed();
    const now = new Date();
    await db.insert(issueComments).values({ companyId, issueId: openChildId, authorType: "agent", authorAgentId: jarvisId, body: "Working on it." });
    await db.insert(activityLog).values({
      companyId, actorType: "agent", actorId: jarvisId, action: "issue.updated", entityType: "issue", entityId: openChildId,
      details: { changes: { status: { from: "todo", to: "in_progress" } } },
    });
    await db.insert(heartbeatRuns).values({
      companyId, agentId: jarvisId, status: "succeeded", invocationSource: "automation", triggerDetail: "system",
      contextSnapshot: { issueId: openChildId }, startedAt: now, finishedAt: now,
    });
    await db.insert(agentWakeupRequests).values({
      companyId, agentId: jarvisId, source: "automation", triggerDetail: "system", reason: "test", status: "queued",
      payload: { issueId: openChildId }, idempotencyKey: "stall-sentinel:test:queued",
    });

    const snapshot = await loadCompanySnapshot(
      { db, measureSilence: async () => null, listActiveRecovery: async () => new Set() },
      companyId, now, 7 * 24 * 60 * 60_000,
    );
    expect(snapshot.issues.size).toBe(3);
    expect(snapshot.blockedBy.get(parentId)?.length).toBe(2);
    expect(snapshot.runs.filter((r) => r.issueId === openChildId)).toHaveLength(1);
    expect(snapshot.wakes.filter((w) => w.issueId === openChildId && w.status === "queued")).toHaveLength(1);
    expect(snapshot.progress.latestByIssue.get(openChildId)).toBeInstanceOf(Date);
    expect(snapshot.progress.issuesWithWork.has(openChildId)).toBe(true);

    const progress = await loadIssueProgressEvents(db, companyId, new Date(now.getTime() - 60_000));
    expect(progress.latestByIssue.has(openChildId)).toBe(true);
    expect(await loadMemoryRows(db, companyId, new Date(now.getTime() - 60_000))).toEqual([]);
    expect(await loadRolloutState(db, companyId)).toEqual({ startedAt: null, selfRepairOnAt: null });
  });
});
