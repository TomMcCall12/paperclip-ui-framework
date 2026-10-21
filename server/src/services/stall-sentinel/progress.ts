import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { CompanySnapshot, WatchedTree } from "./watch-units.js";

/**
 * Progress (design section a): the newest real event on any issue in a tree.
 * Counts: agent or user comments (not from a failed run), new document
 * revisions, work products, agent or user status changes, succeeded runs and
 * running runs, and the creation of the task itself. Does not count: system comments (recovery, watchdog and the
 * sentinel itself), failed runs, queued runs and wake requests.
 */

export interface IssueProgressEvents {
  /** Latest non-run progress event per issue inside the lookback window. */
  latestByIssue: Map<string, Date>;
  /** Open issues with any agent or user comment, document or work product (any age). */
  issuesWithWork: Set<string>;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

export async function loadIssueProgressEvents(db: Db, companyId: string, since: Date): Promise<IssueProgressEvents> {
  const sinceIso = since.toISOString();
  const latest = rowsOf(
    await db.execute(sql`
      SELECT issue_id, max(at) AS at FROM (
        SELECT c.issue_id, max(c.created_at) AS at
          FROM issue_comments c
          LEFT JOIN heartbeat_runs r ON r.id = c.created_by_run_id
         WHERE c.company_id = ${companyId}
           AND c.created_at >= ${sinceIso}::timestamptz
           AND c.deleted_at IS NULL
           AND c.author_type IN ('agent', 'user')
           AND (r.id IS NULL OR r.status NOT IN ('failed', 'timed_out', 'cancelled'))
         GROUP BY c.issue_id
        UNION ALL
        SELECT d.issue_id, max(v.created_at) AS at
          FROM issue_documents d
          JOIN document_revisions v ON v.document_id = d.document_id
         WHERE d.company_id = ${companyId}
           AND v.created_at >= ${sinceIso}::timestamptz
         GROUP BY d.issue_id
        UNION ALL
        SELECT w.issue_id, max(w.updated_at) AS at
          FROM issue_work_products w
         WHERE w.company_id = ${companyId}
           AND w.updated_at >= ${sinceIso}::timestamptz
         GROUP BY w.issue_id
        UNION ALL
        SELECT a.entity_id::uuid AS issue_id, max(a.created_at) AS at
          FROM activity_log a
         WHERE a.company_id = ${companyId}
           AND a.entity_type = 'issue'
           AND a.action = 'issue.updated'
           AND a.actor_type IN ('agent', 'user')
           AND a.created_at >= ${sinceIso}::timestamptz
           AND ((a.details -> 'changes') ? 'status' OR (a.details -> '_previous') ? 'status')
         GROUP BY a.entity_id
      ) events
      GROUP BY issue_id
    `),
  );
  const latestByIssue = new Map<string, Date>();
  for (const row of latest) {
    const at = toDate(row.at);
    if (typeof row.issue_id === "string" && at) latestByIssue.set(row.issue_id, at);
  }

  const withWork = rowsOf(
    await db.execute(sql`
      SELECT i.id FROM issues i
       WHERE i.company_id = ${companyId}
         AND i.status IN ('todo', 'in_progress', 'in_review', 'blocked')
         AND (
           EXISTS (SELECT 1 FROM issue_comments c WHERE c.issue_id = i.id AND c.deleted_at IS NULL AND c.author_type IN ('agent', 'user'))
           OR EXISTS (SELECT 1 FROM issue_documents d WHERE d.issue_id = i.id)
           OR EXISTS (SELECT 1 FROM issue_work_products w WHERE w.issue_id = i.id)
         )
    `),
  );
  return {
    latestByIssue,
    issuesWithWork: new Set(withWork.map((row) => String(row.id))),
  };
}

/** Latest progress on one issue, including run outcomes. */
export function issueProgressAt(snapshot: CompanySnapshot, issueId: string): Date | null {
  let latest = snapshot.progress.latestByIssue.get(issueId) ?? null;
  // Creating a task is the first event in its life, so a new tree is never "old".
  const createdAt = snapshot.issues.get(issueId)?.createdAt ?? null;
  if (createdAt && (!latest || createdAt > latest)) latest = createdAt;
  for (const run of snapshot.runs) {
    if (run.issueId !== issueId) continue;
    const at =
      run.status === "succeeded" ? run.finishedAt : run.status === "running" ? (run.startedAt ?? run.createdAt) : null;
    if (at && (!latest || at > latest)) latest = at;
  }
  return latest;
}

export interface TreeProgress {
  at: Date | null;
  issueId: string | null;
}

export function treeProgress(snapshot: CompanySnapshot, tree: WatchedTree): TreeProgress {
  let best: TreeProgress = { at: null, issueId: null };
  for (const id of tree.issueIds) {
    const at = issueProgressAt(snapshot, id);
    if (at && (!best.at || at > best.at)) best = { at, issueId: id };
  }
  return best;
}

/** Age used by the thresholds. With nothing in the lookback window the age is the window itself plus one ms ("over 7 days"). */
export function treeAgeMs(progress: TreeProgress, now: Date, lookbackMs: number): number {
  return progress.at ? Math.max(0, now.getTime() - progress.at.getTime()) : lookbackMs + 1;
}
