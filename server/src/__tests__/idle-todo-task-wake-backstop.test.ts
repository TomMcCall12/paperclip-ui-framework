import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
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

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Idle todo-task backstop test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { IDLE_TODO_TASK_WAKE_REASON } from "../services/idle-todo-task-wakeups.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres idle todo-task backstop tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

function minutesBefore(reference: Date, minutes: number) {
  return new Date(reference.getTime() - minutes * 60 * 1000);
}

describeEmbeddedPostgres("recovery reconcileIdleTodoTaskWakeBackstop", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-idle-todo-task-backstop-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockTelemetryClient.track.mockClear();
    // Drain any run execution the sweep dispatched before truncating, so no
    // background write races the next test's cleanup. Draining here (after
    // the test body's own assertions already ran) rather than inside each
    // test keeps a wake's dispatch from flipping its issue out of `todo`
    // before a same-test second sweep call gets to see it.
    // Cascading truncate instead of per-table deletes: the wake path this
    // sweep exercises touches many FK-linked tables (activity log, run
    // events, agent runtime state, company skills, ...), and the exact set
    // is an implementation detail of enqueueWakeup/executeRun, not of this
    // test. Matches the same deadlock-safe pattern used by
    // helpers/runner-api-server.ts.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.execute(sql`TRUNCATE companies CASCADE`);
        break;
      } catch (error) {
        const code =
          (error as { code?: string }).code ??
          (error as { cause?: { code?: string } }).cause?.code;
        if (attempt >= 4 || code !== "40P01") throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(agentStatus = "active") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: agentStatus,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedTodoIssue(input: {
    companyId: string;
    agentId: string;
    updatedAt: Date;
    status?: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Idle todo task",
      status: input.status ?? "todo",
      priority: "high",
      assigneeAgentId: input.agentId,
      updatedAt: input.updatedAt,
    });
    return issueId;
  }

  it("wakes the assignee of a todo task idle for more than 10 minutes", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoIssue({
      companyId,
      agentId,
      updatedAt: minutesBefore(new Date(), 15),
    });

    const result = await heartbeat.reconcileIdleTodoTaskWakes({ companyId });

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const wake = await db
      .select({ reason: agentWakeupRequests.reason, agentId: agentWakeupRequests.agentId, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, IDLE_TODO_TASK_WAKE_REASON))
      .then((rows) => rows[0]);
    expect(wake?.agentId).toBe(agentId);
    // The sweep only needs the wake durably queued; downstream dispatch
    // status (claimed/running/completed/...) races this assertion and is out
    // of scope — only "skipped" would mean the wake was not actually acted on.
    expect(wake?.status).not.toBe("skipped");
  });

  it("does not wake a todo task that has not been idle for 10 minutes yet", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await seedTodoIssue({
      companyId,
      agentId,
      updatedAt: minutesBefore(new Date(), 2),
    });

    const result = await heartbeat.reconcileIdleTodoTaskWakes({ companyId });

    expect(result.healed).toBe(0);
    const wakes = await db.select().from(agentWakeupRequests);
    expect(wakes).toHaveLength(0);
  });

  it("does not wake a paused assignee", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("paused");
    await seedTodoIssue({
      companyId,
      agentId,
      updatedAt: minutesBefore(new Date(), 15),
    });

    const result = await heartbeat.reconcileIdleTodoTaskWakes({ companyId });

    expect(result.healed).toBe(0);
    expect(result.nonInvokableSkipped).toBe(1);
    const wakes = await db.select().from(agentWakeupRequests);
    expect(wakes).toHaveLength(0);
  });

  it("does not wake a task that already has a live run", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoIssue({
      companyId,
      agentId,
      updatedAt: minutesBefore(new Date(), 15),
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });

    const result = await heartbeat.reconcileIdleTodoTaskWakes({ companyId });

    expect(result.healed).toBe(0);
    expect(result.livePathSkipped).toBe(1);
  });

  async function seedIdleTodoTaskWake(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    requestedAt: Date;
    status?: string;
  }) {
    await db.insert(agentWakeupRequests).values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: IDLE_TODO_TASK_WAKE_REASON,
      payload: { issueId: input.issueId },
      status: input.status ?? "queued",
      requestedAt: input.requestedAt,
    });
  }

  // These two cases seed the prior wake directly rather than taking it from a
  // real first sweep call: `enqueueWakeup` dispatches the queued run's
  // checkout immediately in the background, which (with the mocked adapter
  // resolving fast) can flip the issue out of `todo` before a second sweep
  // call in the same test observes it — a dispatch-timing artifact of this
  // test, not a product bug. Seeding the row directly tests the same cooldown
  // query deterministically.
  it("does not queue a second wake for the same task inside the hourly cooldown", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoIssue({
      companyId,
      agentId,
      updatedAt: minutesBefore(new Date(), 15),
    });
    await seedIdleTodoTaskWake({
      companyId,
      agentId,
      issueId,
      requestedAt: minutesBefore(new Date(), 10),
    });

    const result = await heartbeat.reconcileIdleTodoTaskWakes({ companyId });

    expect(result.healed).toBe(0);
    expect(result.existingWakeSkipped).toBe(1);
    const wakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, IDLE_TODO_TASK_WAKE_REASON),
        ),
      );
    expect(wakes).toHaveLength(1);
  });

  it("wakes again once the hourly cooldown has elapsed", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoIssue({
      companyId,
      agentId,
      updatedAt: minutesBefore(new Date(), 90),
    });
    await seedIdleTodoTaskWake({
      companyId,
      agentId,
      issueId,
      requestedAt: minutesBefore(new Date(), 61),
    });

    const result = await heartbeat.reconcileIdleTodoTaskWakes({ companyId });

    expect(result.healed).toBe(1);
    expect(result.existingWakeSkipped).toBe(0);
    const wakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, IDLE_TODO_TASK_WAKE_REASON));
    expect(wakes).toHaveLength(2);
  });
});
