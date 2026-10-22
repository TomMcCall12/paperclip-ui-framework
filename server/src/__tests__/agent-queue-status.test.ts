import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent queue status tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentService.getQueueStatus", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-queue-status-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reports running count against maxConcurrentRuns and the oldest waiting task", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runningRunId = randomUUID();
    const activeWaitingRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Overnight Co",
      issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Night Shift Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
    });

    // Older waiting task: not currently running, should be reported as the oldest wait.
    const olderIssueId = randomUUID();
    await db.insert(issues).values({
      id: olderIssueId,
      companyId,
      title: "Oldest queued task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    // Newer waiting task: also waiting, but more recent than the one above.
    const newerIssueId = randomUUID();
    await db.insert(issues).values({
      id: newerIssueId,
      companyId,
      title: "Newer queued task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      updatedAt: new Date("2026-01-05T00:00:00.000Z"),
    });

    // Task with a live run attached: must not count as waiting even though its
    // own status is in_progress, because it is already executing.
    const activeIssueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: activeWaitingRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
    });
    await db.insert(issues).values({
      id: activeIssueId,
      companyId,
      title: "Already executing task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: activeWaitingRunId,
      updatedAt: new Date("2025-12-01T00:00:00.000Z"),
    });

    // Done task: should never be counted as waiting.
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Finished task",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      updatedAt: new Date("2025-11-01T00:00:00.000Z"),
    });

    const [status] = await agentService(db).getQueueStatus(companyId, { agentIds: [agentId] });

    expect(status).toMatchObject({
      agentId,
      runningCount: 1,
      maxConcurrentRuns: 2,
      waitingCount: 2,
      oldestWaitIssueId: olderIssueId,
    });
    expect(status?.oldestWaitSeconds).toBeGreaterThan(0);
  });

  it("falls back to the default maxConcurrentRuns and reports zero waiting when nothing is queued", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Quiet Co",
      issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Idle Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const [status] = await agentService(db).getQueueStatus(companyId, { agentIds: [agentId] });

    expect(status).toMatchObject({
      agentId,
      runningCount: 0,
      waitingCount: 0,
      oldestWaitSeconds: null,
      oldestWaitIssueId: null,
    });
    expect(status?.maxConcurrentRuns).toBeGreaterThan(0);
  });
});
