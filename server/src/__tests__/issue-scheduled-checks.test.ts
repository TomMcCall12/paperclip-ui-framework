import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueScheduledChecks,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  cancelIssueScheduledCheck,
  createIssueScheduledCheck,
  listIssueScheduledChecks,
  runIssueScheduledCheckNow,
  syncPrimaryScheduledCheckFromExecutionPolicy,
  tickDueIssueScheduledChecks,
  updateIssueScheduledCheck,
} from "../services/issue-scheduled-checks.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue scheduled check tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue_scheduled_checks service (TOM-413)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-scheduled-checks-svc-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueScheduledChecks);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(options?: { status?: "in_progress" | "in_review" | "todo" }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scheduled checks bot",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Multi check-in issue",
      status: options?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  it("supports many independent check-ins on one issue", async () => {
    const { companyId, issueId } = await seedIssue();

    const first = await createIssueScheduledCheck(db, {
      companyId,
      issueId,
      createdByUserId: "tom",
      input: { nextCheckAt: new Date("2026-05-01T09:00:00.000Z").toISOString(), notes: "Morning check" },
    });
    const second = await createIssueScheduledCheck(db, {
      companyId,
      issueId,
      createdByUserId: "tom",
      input: { nextCheckAt: new Date("2026-05-02T09:00:00.000Z").toISOString(), notes: "Next-day check" },
    });

    const listed = await listIssueScheduledChecks(db, issueId);
    expect(listed.map((c) => c.id).sort()).toEqual([first.id, second.id].sort());
    expect(listed.every((c) => c.isPrimary === false)).toBe(true);
  });

  it("coalesces several due rows for the same issue into one wake, and marks each fired", async () => {
    const { companyId, issueId, agentId } = await seedIssue();
    const now = new Date("2026-05-01T09:00:00.000Z");

    const a = await createIssueScheduledCheck(db, {
      companyId,
      issueId,
      createdByUserId: "tom",
      input: { nextCheckAt: new Date(now.getTime() - 60_000).toISOString(), notes: "First due note" },
    });
    const b = await createIssueScheduledCheck(db, {
      companyId,
      issueId,
      createdByUserId: "tom",
      input: { nextCheckAt: new Date(now.getTime() - 30_000).toISOString(), notes: "Second due note" },
    });
    // Not due yet; must not be dispatched or coalesced in.
    const notDue = await createIssueScheduledCheck(db, {
      companyId,
      issueId,
      createdByUserId: "tom",
      input: { nextCheckAt: new Date(now.getTime() + 60_000).toISOString(), notes: "Future note" },
    });

    const wakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const logActivity = vi.fn().mockResolvedValue(undefined);

    const result = await tickDueIssueScheduledChecks(db, { wakeup, logActivity }, now);

    expect(result).toMatchObject({ checked: 2, triggered: 1, coalescedIssues: 1 });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        reason: "issue_scheduled_check_due",
        payload: expect.objectContaining({
          issueId,
          notes: "First due note\n\nSecond due note",
        }),
      }),
    );

    const rows = await listIssueScheduledChecks(db, issueId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a.id)).toMatchObject({ status: "fired", attemptCount: 1 });
    expect(byId.get(b.id)).toMatchObject({ status: "fired", attemptCount: 1 });
    expect(byId.get(notDue.id)).toMatchObject({ status: "scheduled", attemptCount: 0 });

    expect(logActivity).toHaveBeenCalledTimes(2);
  });

  it("reschedules a recurring check-in instead of marking it fired for good", async () => {
    const { companyId, issueId } = await seedIssue();
    const now = new Date("2026-05-04T08:29:00.000Z"); // Monday 08:29 UTC

    const recurring = await createIssueScheduledCheck(db, {
      companyId,
      issueId,
      createdByUserId: "tom",
      input: {
        nextCheckAt: now.toISOString(),
        notes: "Every weekday morning",
        recurrenceCron: "30 8 * * 1",
        recurrenceTimezone: "UTC",
      },
    });

    const wakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const logActivity = vi.fn().mockResolvedValue(undefined);
    await tickDueIssueScheduledChecks(
      db,
      { wakeup, logActivity },
      new Date(now.getTime() + 60_000),
    );

    const [updated] = await db
      .select()
      .from(issueScheduledChecks)
      .where(eq(issueScheduledChecks.id, recurring.id));
    expect(updated?.status).toBe("scheduled");
    expect(updated?.attemptCount).toBe(1);
    expect(updated?.nextCheckAt?.toISOString()).toBe("2026-05-11T08:30:00.000Z");
  });

  it("does not dispatch the primary row through the multi-row tick (legacy loop owns it)", async () => {
    const { companyId, issueId } = await seedIssue();
    const now = new Date("2026-05-01T09:00:00.000Z");
    await db.insert(issueScheduledChecks).values({
      companyId,
      issueId,
      nextCheckAt: new Date(now.getTime() - 60_000),
      notes: "Legacy primary monitor",
      isPrimary: true,
      status: "scheduled",
    });

    const wakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const logActivity = vi.fn().mockResolvedValue(undefined);
    const result = await tickDueIssueScheduledChecks(db, { wakeup, logActivity }, now);

    expect(result).toMatchObject({ checked: 0, triggered: 0 });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("run-now triggers a single pending check immediately and skips an ineligible issue", async () => {
    const { companyId, issueId } = await seedIssue();
    const check = await createIssueScheduledCheck(db, {
      companyId,
      issueId,
      createdByUserId: "tom",
      input: { nextCheckAt: new Date("2026-06-01T00:00:00.000Z").toISOString() },
    });

    const wakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const logActivity = vi.fn().mockResolvedValue(undefined);
    const triggered = await runIssueScheduledCheckNow(
      db,
      { wakeup, logActivity },
      { issueId, checkId: check.id },
    );
    expect(triggered.outcome).toBe("triggered");
    expect(wakeup).toHaveBeenCalledTimes(1);

    // Re-running a now-"fired" check throws conflict, matching legacy run-now semantics.
    await expect(
      runIssueScheduledCheckNow(db, { wakeup, logActivity }, { issueId, checkId: check.id }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("run-now reports skipped (not an error) for a done issue", async () => {
    const { companyId, issueId } = await seedIssue({ status: "todo" });
    const check = await createIssueScheduledCheck(db, {
      companyId,
      issueId,
      createdByUserId: "tom",
      input: { nextCheckAt: new Date("2026-06-01T00:00:00.000Z").toISOString() },
    });
    const wakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const logActivity = vi.fn().mockResolvedValue(undefined);
    const result = await runIssueScheduledCheckNow(
      db,
      { wakeup, logActivity },
      { issueId, checkId: check.id },
    );
    expect(result.outcome).toBe("skipped");
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("mirrors the legacy executionPolicy.monitor PATCH path onto a primary row (back-compat)", async () => {
    const { companyId, issueId } = await seedIssue();

    await syncPrimaryScheduledCheckFromExecutionPolicy(db, {
      companyId,
      issueId,
      monitor: { nextCheckAt: "2026-05-05T10:00:00.000Z", notes: "Set via legacy PATCH" },
      createdByAgentId: null,
      createdByUserId: "tom",
    });

    let rows = await listIssueScheduledChecks(db, issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      isPrimary: true,
      notes: "Set via legacy PATCH",
      status: "scheduled",
    });
    const primaryId = rows[0]!.id;

    // A second legacy PATCH call updates the same primary row rather than creating a new one.
    await syncPrimaryScheduledCheckFromExecutionPolicy(db, {
      companyId,
      issueId,
      monitor: { nextCheckAt: "2026-05-06T10:00:00.000Z", notes: "Updated via legacy PATCH" },
      createdByAgentId: null,
      createdByUserId: "tom",
    });
    rows = await listIssueScheduledChecks(db, issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: primaryId, notes: "Updated via legacy PATCH" });

    // Clearing the legacy monitor (PATCH executionPolicy.monitor: null) cancels the row,
    // it does not delete history.
    await syncPrimaryScheduledCheckFromExecutionPolicy(db, {
      companyId,
      issueId,
      monitor: null,
      createdByAgentId: null,
      createdByUserId: "tom",
    });
    rows = await listIssueScheduledChecks(db, issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: primaryId,
      status: "cancelled",
      cancelReason: "execution_policy_cleared",
    });
  });

  it("updates and cancels a non-primary check-in via the first-class CRUD path", async () => {
    const { companyId, issueId } = await seedIssue();
    const check = await createIssueScheduledCheck(db, {
      companyId,
      issueId,
      createdByUserId: "tom",
      input: { nextCheckAt: new Date("2026-05-10T00:00:00.000Z").toISOString(), notes: "Original" },
    });

    const updated = await updateIssueScheduledCheck(db, {
      issueId,
      checkId: check.id,
      input: { notes: "Edited note" },
    });
    expect(updated.notes).toBe("Edited note");

    const cancelled = await cancelIssueScheduledCheck(db, { issueId, checkId: check.id });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelReason).toBe("deleted");
  });
});
