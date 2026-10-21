import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueCreateIdempotencyKeys,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue step key tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue step key", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-step-key-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedParent(companyId: string, title = "Parent issue") {
    const [parent] = await db.insert(issues).values({
      companyId,
      title,
      status: "todo",
      priority: "medium",
    }).returning();
    return parent;
  }

  const create = (app: express.Express, companyId: string, body: Record<string, unknown>) =>
    request(app).post(`/api/companies/${companyId}/issues`).send(body);

  it("returns the existing issue when the same step is created twice", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await create(app, companyId, { parentId: parent.id, title: "S3: Build the alarm" }).expect(201);
    // A different title proves the match is on the step, not the title.
    const second = await create(app, companyId, { parentId: parent.id, title: "S3: Build the alarm again" }).expect(200);

    expect(second.body).toMatchObject({
      id: first.body.id,
      deduplicated: true,
      deduplicationReason: "step_key",
    });
    expect(await db.select().from(issues).where(eq(issues.parentId, parent.id))).toHaveLength(1);
  });

  it("creates exactly one issue from two simultaneous creates of the same step", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const responses = await Promise.all([
      create(app, companyId, { parentId: parent.id, title: "S4: First wording" }),
      create(app, companyId, { parentId: parent.id, title: "S4: Second wording" }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(responses[0].body.id).toBe(responses[1].body.id);
    expect(responses.find((response) => response.status === 200)?.body).toMatchObject({
      deduplicated: true,
      deduplicationReason: "step_key",
    });
    expect(await db.select().from(issues).where(eq(issues.parentId, parent.id))).toHaveLength(1);
  });

  it("creates exactly one issue from many simultaneous creates, including allowDuplicate", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        create(app, companyId, {
          parentId: parent.id,
          title: `S6: Wording ${index}`,
          allowDuplicate: index % 2 === 0,
        }),
      ),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(5);
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
    expect(await db.select().from(issues).where(eq(issues.parentId, parent.id))).toHaveLength(1);
  });

  it("allows the same step under different parents", async () => {
    const companyId = await seedCompany();
    const parentA = await seedParent(companyId, "Parent A");
    const parentB = await seedParent(companyId, "Parent B");
    const app = createApp();

    const a = await create(app, companyId, { parentId: parentA.id, title: "S3: Build the alarm" }).expect(201);
    const b = await create(app, companyId, { parentId: parentB.id, title: "S3: Build the alarm" }).expect(201);

    expect(a.body.id).not.toBe(b.body.id);
  });

  it("allows a new copy once the earlier one is cancelled or done", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await create(app, companyId, { parentId: parent.id, title: "S3: Build the alarm" }).expect(201);
    await db.update(issues).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(issues.id, first.body.id));
    const second = await create(app, companyId, { parentId: parent.id, title: "S3: Build the alarm" }).expect(201);
    expect(second.body.id).not.toBe(first.body.id);

    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, second.body.id));
    await create(app, companyId, { parentId: parent.id, title: "S3: Build the alarm" }).expect(201);
  });

  it("stores derived keys for S<n>:, S<n>-r<k>: and lettered steps, and none for other titles", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const keyed = await create(app, companyId, { parentId: parent.id, title: "S5e: Close the fail-open reset" }).expect(201);
    const retry = await create(app, companyId, { parentId: parent.id, title: "S3-r2: Redo the alarm" }).expect(201);
    const plain = await create(app, companyId, { parentId: parent.id, title: "Write the report" }).expect(201);

    const rows = await db.select({ id: issues.id, stepKey: issues.stepKey }).from(issues).where(eq(issues.parentId, parent.id));
    const byId = new Map(rows.map((row) => [row.id, row.stepKey]));
    expect(byId.get(keyed.body.id)).toBe(`${parent.id}:S5e`);
    expect(byId.get(retry.body.id)).toBe(`${parent.id}:S3-r2`);
    expect(byId.get(plain.body.id)).toBeNull();
  });

  it("treats S3 and S3-r2 as different steps", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    await create(app, companyId, { parentId: parent.id, title: "S3: Build the alarm" }).expect(201);
    await create(app, companyId, { parentId: parent.id, title: "S3-r2: Build the alarm" }).expect(201);
  });

  it("does not bypass the step key with allowDuplicate", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await create(app, companyId, { parentId: parent.id, title: "S3: Build the alarm" }).expect(201);
    const second = await create(app, companyId, {
      parentId: parent.id,
      title: "S3: Build the alarm",
      allowDuplicate: true,
    }).expect(200);

    expect(second.body).toMatchObject({ id: first.body.id, deduplicationReason: "step_key" });
  });

  it("records a supplied idempotency key against the existing step", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await create(app, companyId, { parentId: parent.id, title: "S3: Build the alarm" }).expect(201);
    const second = await create(app, companyId, {
      parentId: parent.id,
      title: "S3: Build the alarm",
      idempotencyKey: "run-9:s3",
    }).expect(200);
    expect(second.body).toMatchObject({ id: first.body.id, deduplicationReason: "step_key" });
    expect(await db.select().from(issueCreateIdempotencyKeys)).toEqual([
      expect.objectContaining({ issueId: first.body.id, idempotencyKey: "run-9:s3" }),
    ]);
  });

  it("leaves top-level issues and non-step titles unchanged", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    // Top-level "S3:" issues never get a key, so allowDuplicate still makes two.
    const a = await create(app, companyId, { title: "S3: Top level", allowDuplicate: true }).expect(201);
    const b = await create(app, companyId, { title: "S3: Top level", allowDuplicate: true }).expect(201);
    expect(a.body.id).not.toBe(b.body.id);

    // Non-step titles keep today's behaviour: allowDuplicate creates, default dedupes by title.
    const first = await create(app, companyId, { parentId: parent.id, title: "Write the report" }).expect(201);
    const copy = await create(app, companyId, { parentId: parent.id, title: "Write the report", allowDuplicate: true }).expect(201);
    expect(copy.body.id).not.toBe(first.body.id);
    const dupe = await create(app, companyId, { parentId: parent.id, title: "Write the report" }).expect(200);
    expect(dupe.body.deduplicationReason).toBe("recent_open_title");

    const rows = await db.select({ stepKey: issues.stepKey }).from(issues).where(
      and(eq(issues.companyId, companyId)),
    );
    expect(rows.every((row) => row.stepKey === null)).toBe(true);
  });

  it("ignores a stepKey sent by the caller", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const created = await create(app, companyId, {
      parentId: parent.id,
      title: "Write the report",
      stepKey: `${parent.id}:S1`,
    }).expect(201);
    const [row] = await db.select({ stepKey: issues.stepKey }).from(issues).where(eq(issues.id, created.body.id));
    expect(row.stepKey).toBeNull();
  });

  it("returns 409 step_key_conflict when reopening a cancelled copy while another is open", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const old = await create(app, companyId, { parentId: parent.id, title: "S3: Build the alarm" }).expect(201);
    await db.update(issues).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(issues.id, old.body.id));
    const replacement = await create(app, companyId, { parentId: parent.id, title: "S3: Build the alarm" }).expect(201);

    const reopened = await request(app).patch(`/api/issues/${old.body.id}`).send({ status: "todo" });
    expect(reopened.status).toBe(409);
    expect(reopened.body).toMatchObject({
      code: "step_key_conflict",
      details: { code: "step_key_conflict", existingIssueId: replacement.body.id },
    });
    const [still] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, old.body.id));
    expect(still.status).toBe("cancelled");
  });

  it("recomputes the step key on rename and returns 409 when the new step is taken", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const s3 = await create(app, companyId, { parentId: parent.id, title: "S3: Build the alarm" }).expect(201);
    const other = await create(app, companyId, { parentId: parent.id, title: "Write the report" }).expect(201);

    const taken = await request(app).patch(`/api/issues/${other.body.id}`).send({ title: "S3: Report as step" });
    expect(taken.status).toBe(409);
    expect(taken.body.details).toMatchObject({ code: "step_key_conflict", existingIssueId: s3.body.id });

    await request(app).patch(`/api/issues/${other.body.id}`).send({ title: "S9: Report as step" }).expect(200);
    const [renamed] = await db.select({ stepKey: issues.stepKey }).from(issues).where(eq(issues.id, other.body.id));
    expect(renamed.stepKey).toBe(`${parent.id}:S9`);

    await request(app).patch(`/api/issues/${other.body.id}`).send({ title: "Plain title again" }).expect(200);
    const [cleared] = await db.select({ stepKey: issues.stepKey }).from(issues).where(eq(issues.id, other.body.id));
    expect(cleared.stepKey).toBeNull();
  });
});
