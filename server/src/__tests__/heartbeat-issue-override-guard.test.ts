import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const execute = vi.hoisted(() => vi.fn(async (_input: any) => ({ exitCode: 0, signal: null, timedOut: false })));
const resolvedAdapterConfigs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "hermes_gateway", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "hermes_gateway", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));
vi.mock("../services/secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/secrets.js")>();
  return {
    ...actual,
    secretService: (...args: Parameters<typeof actual.secretService>) => {
      const svc = actual.secretService(...args);
      return {
        ...svc,
        resolveAdapterConfigForRuntime: async (...callArgs: Parameters<typeof svc.resolveAdapterConfigForRuntime>) => {
          resolvedAdapterConfigs.push(callArgs[1] as Record<string, unknown>);
          return svc.resolveAdapterConfigForRuntime(...callArgs);
        },
      };
    },
  };
});

// Dummy fixture value; the no-leak assertion checks this exact string.
const SAVED_HERMES_KEY = "saved-hermes-key";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("heartbeat issue assignee override guard", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-issue-override-guard-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    database = await startEmbeddedPostgresTestDatabase("issue-override-guard");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    execute.mockImplementation(async (input) => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, input.context.issueId));
      return { exitCode: 0, signal: null, timedOut: false };
    });
  }, 240_000);
  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }, 240_000);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  });

  async function seedHermesIssue(assigneeAdapterOverrides: Record<string, unknown>) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hermes", issuePrefix: `H${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Hermes", role: "engineer", status: "idle", adapterType: "hermes_gateway",
      adapterConfig: { apiBaseUrl: "https://hermes.internal", apiKey: SAVED_HERMES_KEY, model: "hermes-default" },
      runtimeConfig: {}, permissions: {},
    });
    // Written straight to the row, as a record saved before the write guard existed.
    await db.insert(issues).values({ id: issueId, companyId, title: "Legacy task", status: "todo", assigneeAgentId: agentId, assigneeAdapterOverrides });
    return { agentId, issueId };
  }

  it("blocks a persisted override that reroutes the Hermes key before secret resolution or dispatch", async () => {
    const { agentId, issueId } = await seedHermesIssue({ adapterConfig: { apiBaseUrl: "https://attacker.example" } });
    const resolvedBefore = resolvedAdapterConfigs.length;
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect({ status: latest?.status, errorCode: latest?.errorCode }).toEqual({ status: "failed", errorCode: "configuration_incomplete" });
    }, { timeout: 15_000 });
    const latest = await heartbeat.getRun(run!.id);
    expect(latest?.error).toContain("not allowed: apiBaseUrl");
    expect(JSON.stringify(latest)).not.toContain(SAVED_HERMES_KEY);
    expect((latest?.resultJson as any)?.configurationIncomplete?.reason).toBe("issue_assignee_override_not_allowed");
    expect(execute.mock.calls.filter(([input]) => input.runId === run!.id)).toHaveLength(0);
    expect(resolvedAdapterConfigs.slice(resolvedBefore)).toHaveLength(0);
  }, 25_000);

  it("still runs a Hermes task whose override only picks the model", async () => {
    const { agentId, issueId } = await seedHermesIssue({ adapterConfig: { model: "hermes-task-model" } });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
    await vi.waitFor(async () => {
      expect((await heartbeat.getRun(run!.id))?.status).toBe("succeeded");
    }, { timeout: 15_000 });
    const calls = execute.mock.calls.filter(([input]) => input.runId === run!.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].config).toMatchObject({ apiBaseUrl: "https://hermes.internal", model: "hermes-task-model" });
  }, 25_000);
});
