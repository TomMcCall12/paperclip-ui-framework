import { and, desc, eq, gte, ilike, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companies,
  costEvents,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type {
  PendingLabChangeItem,
  PendingLabChanges,
  PendingLabChangesDeployState,
  RequestConfirmationPayload,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import { executionIssueCondition } from "./issue-visibility.js";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;

/** The convention the `toms-lab-self-update` skill uses to name the one open rebuild queue task. */
const REBUILD_QUEUE_TITLE_PREFIX = "Rebuild queue:";
/** The host update command's own progress-comment prefix on the queue task. */
const LAB_UPDATER_COMMENT_PREFIX = "**Tom's Lab updater:**";

const COMMIT_LINE_PATTERN = /Commit `([0-9a-f]{6,40})` on `([^`]+)`/i;
const TABLE_ROW_PATTERN = /^\|(.+)\|(.+)\|\s*$/;
const TASK_LINK_PATTERN = /\[(\S+)\]\(([^)]+)\)/;

export function parseQueueDescription(description: string | null): {
  commit: string | null;
  branch: string | null;
  items: PendingLabChangeItem[];
} {
  if (!description) return { commit: null, branch: null, items: [] };

  const commitMatch = description.match(COMMIT_LINE_PATTERN);
  const commit = commitMatch?.[1] ?? null;
  const branch = commitMatch?.[2] ?? null;

  const lines = description.split("\n");
  const items: PendingLabChangeItem[] = [];
  let pastHeader = false;
  let pastSeparator = false;
  for (const line of lines) {
    const row = line.match(TABLE_ROW_PATTERN);
    if (!row) {
      if (pastHeader) break; // the table ended
      continue;
    }
    const [, col1, col2] = row;
    if (!pastHeader) {
      if (/^change$/i.test(col1.trim()) && /^task$/i.test(col2.trim())) {
        pastHeader = true;
      }
      continue;
    }
    if (!pastSeparator) {
      // The `|---|---|` row right after the header.
      pastSeparator = true;
      continue;
    }
    const title = col1.trim();
    const taskCell = col2.trim();
    const linkMatch = taskCell.match(TASK_LINK_PATTERN);
    items.push({
      title,
      taskIdentifier: linkMatch?.[1] ?? null,
      href: linkMatch ? `/issues/${linkMatch[1]}` : null,
      source: linkMatch ? null : taskCell,
    });
  }

  return { commit, branch, items };
}

export function inferDeployState(
  confirmationStatus: string | null,
  updaterNote: string | null,
): PendingLabChangesDeployState | null {
  if (!confirmationStatus) return null;
  if (confirmationStatus === "pending") return "awaiting_approval";
  if (confirmationStatus === "rejected" || confirmationStatus === "cancelled") return "declined";
  if (confirmationStatus === "expired" || confirmationStatus === "failed") return "expired";
  // accepted: read the host update command's own progress note, the only
  // place the build/deploy/rollback lifecycle is recorded today.
  const note = updaterNote ?? "";
  if (/is live as/i.test(note)) return "live";
  if (/rolled back|restore `/i.test(note)) return "rolled_back";
  if (/\bbuilding\b/i.test(note)) return "building";
  if (/\bfailed\b/i.test(note)) return "failed";
  return "queued";
}

function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getRecentUtcDateKeys(now: Date, days: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - (days - 1);
    return formatUtcDateKey(new Date(todayUtc + dayOffset * 24 * 60 * 60 * 1000));
  });
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), executionIssueCondition()))
        .groupBy(issues.status);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const monthStart = getUtcMonthStart(now);
      const runActivityDays = getRecentUtcDateKeys(now, DASHBOARD_RUN_ACTIVITY_DAYS);
      const runActivityStart = new Date(`${runActivityDays[0]}T00:00:00.000Z`);
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      // Per-day run breakdown. A run is "recovered" when its retry chain later
      // succeeded (recovered_runs = all ancestors of a succeeded retry), so a
      // restart-killed run whose retry succeeded is pulled out of the headline
      // failed count. error_code is carried through so a failure spike can be
      // attributed to an error class (e.g. process_lost, provider_quota).
      // Both recursive arms are bounded to the chart window: a retry is always
      // created after the run it retries, so ancestors of an out-of-window
      // child are themselves out of window and invisible to the membership
      // test below. Unbounded, the seed walks every run the company ever had.
      const runActivityRows = (await db.execute(sql`
        WITH RECURSIVE recovered_runs(id) AS (
          SELECT parent.id
          FROM ${heartbeatRuns} AS child
          JOIN ${heartbeatRuns} AS parent ON parent.id = child.retry_of_run_id
          WHERE child.company_id = ${companyId}
            AND child.status = 'succeeded'
            AND child.created_at >= ${runActivityStart.toISOString()}::timestamptz
          UNION
          SELECT parent.id
          FROM recovered_runs rr
          JOIN ${heartbeatRuns} AS child ON child.id = rr.id
          JOIN ${heartbeatRuns} AS parent ON parent.id = child.retry_of_run_id
          WHERE child.created_at >= ${runActivityStart.toISOString()}::timestamptz
        )
        SELECT
          to_char(run.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
          run.status AS status,
          run.error_code AS error_code,
          (run.id IN (SELECT id FROM recovered_runs)) AS recovered,
          count(*)::double precision AS count
        FROM ${heartbeatRuns} AS run
        WHERE run.company_id = ${companyId}
          AND run.created_at >= ${runActivityStart.toISOString()}::timestamptz
        GROUP BY date, run.status, run.error_code, recovered
      `)) as unknown as Iterable<{
        date: string;
        status: string;
        error_code: string | null;
        recovered: boolean | string;
        count: number | string;
      }>;

      const runActivity = new Map(
        runActivityDays.map((date) => [
          date,
          {
            date,
            succeeded: 0,
            failed: 0,
            recovered: 0,
            other: 0,
            total: 0,
            failedByErrorCode: {} as Record<string, number>,
          },
        ]),
      );
      for (const row of runActivityRows) {
        const bucket = runActivity.get(String(row.date));
        if (!bucket) continue;
        const count = Number(row.count);
        const status = String(row.status);
        // Postgres booleans can arrive as JS boolean or "t"/"true" depending on driver.
        const recovered = row.recovered === true || row.recovered === "t" || row.recovered === "true";
        if (status === "succeeded") {
          bucket.succeeded += count;
        } else if (status === "failed" || status === "timed_out") {
          if (recovered) {
            bucket.recovered += count;
          } else {
            bucket.failed += count;
            const code =
              typeof row.error_code === "string" && row.error_code.length > 0
                ? row.error_code
                : "unknown";
            bucket.failedByErrorCode[code] = (bucket.failedByErrorCode[code] ?? 0) + count;
          }
        } else {
          bucket.other += count;
        }
        bucket.total += count;
      }

      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        runActivity: Array.from(runActivity.values()),
      };
    },
    pendingLabChanges: async (companyId: string): Promise<PendingLabChanges> => {
      const [queueIssue] = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          description: issues.description,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            ilike(issues.title, `${REBUILD_QUEUE_TITLE_PREFIX}%`),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        )
        .orderBy(desc(issues.createdAt))
        .limit(1);

      if (!queueIssue || !queueIssue.identifier) {
        return { issue: null, commit: null, branch: null, items: [], confirmation: null, deployState: null };
      }

      const { commit, branch, items } = parseQueueDescription(queueIssue.description);

      const [confirmation] = await db
        .select({
          id: issueThreadInteractions.id,
          status: issueThreadInteractions.status,
          payload: issueThreadInteractions.payload,
        })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.issueId, queueIssue.id),
            eq(issueThreadInteractions.kind, "request_confirmation"),
          ),
        )
        .orderBy(desc(issueThreadInteractions.createdAt))
        .limit(1);

      const [updaterComment] = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, queueIssue.id),
            ilike(issueComments.body, `${LAB_UPDATER_COMMENT_PREFIX}%`),
          ),
        )
        .orderBy(desc(issueComments.createdAt))
        .limit(1);

      const deployState = inferDeployState(confirmation?.status ?? null, updaterComment?.body ?? null);

      return {
        issue: {
          id: queueIssue.id,
          identifier: queueIssue.identifier,
          title: queueIssue.title,
          href: `/issues/${queueIssue.identifier}`,
        },
        commit,
        branch,
        items,
        confirmation: confirmation
          ? (() => {
              const payload = confirmation.payload as RequestConfirmationPayload;
              return {
                id: confirmation.id,
                status: confirmation.status,
                prompt: payload.prompt,
                acceptLabel: payload.acceptLabel ?? null,
                rejectLabel: payload.rejectLabel ?? null,
              };
            })()
          : null,
        deployState,
      };
    },
  };
}
