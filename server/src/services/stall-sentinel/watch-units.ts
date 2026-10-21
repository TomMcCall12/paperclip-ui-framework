import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueLabels,
  issueRelations,
  issues,
  issueThreadInteractions,
  labels,
  lines,
} from "@paperclipai/db";
import { ROUTINE_ORIGIN_KIND, STALL_SENTINEL_EXCLUDED_ROOT_ORIGIN_KINDS } from "./config.js";
import { loadIssueProgressEvents, type IssueProgressEvents } from "./progress.js";

/**
 * Watched trees (design section a): each open Line root and each open
 * top-level task outside a Line, with all descendants. Everything here reads;
 * nothing writes and nothing takes a lock.
 */

export const OPEN_STATUSES: ReadonlySet<string> = new Set(["todo", "in_progress", "in_review", "blocked"]);

export interface SnapshotIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  parentId: string | null;
  lineId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  statusVersion: number;
  originKind: string | null;
  hiddenAt: Date | null;
  conversationAgentId: string | null;
  monitorNextCheckAt: Date | null;
  unblockDescriptor: unknown;
  assigneeAdapterOverrides: unknown;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
}

export interface SnapshotRun {
  id: string;
  agentId: string;
  issueId: string | null;
  status: string;
  errorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  scheduledRetryAt: Date | null;
  /** Output silence from the active-run watchdog measure, for running runs. */
  silenceAgeMs: number | null;
}

export interface SnapshotWake {
  id: string;
  agentId: string;
  issueId: string | null;
  status: string;
  reason: string | null;
  idempotencyKey: string | null;
  requestedAt: Date;
}

export interface SnapshotAgent {
  id: string;
  name: string;
  role: string | null;
  status: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

export interface CompanySnapshot {
  companyId: string;
  now: Date;
  issues: Map<string, SnapshotIssue>;
  lineRootIds: Set<string>;
  /** blocker id -> blocked ids, and blocked id -> blocker ids. */
  blocks: Map<string, string[]>;
  blockedBy: Map<string, string[]>;
  runs: SnapshotRun[];
  wakes: SnapshotWake[];
  agents: Map<string, SnapshotAgent>;
  progress: IssueProgressEvents;
  /** Issues with a pending interaction or a pending linked approval. */
  waitingOnBoardIssueIds: Set<string>;
  /** Issues owned by the recovery loop (active recovery action). */
  activeRecoveryIssueIds: Set<string>;
  labelsByIssue: Map<string, string[]>;
  lastUserOverrideAt: Map<string, Date>;
}

export interface WatchedTree {
  rootId: string;
  issueIds: Set<string>;
  isRoutine: boolean;
}

export function isOpen(issue: SnapshotIssue | undefined): issue is SnapshotIssue {
  return !!issue && OPEN_STATUSES.has(issue.status) && !issue.hiddenAt;
}

function childrenIndex(snapshot: CompanySnapshot) {
  const children = new Map<string, string[]>();
  for (const issue of snapshot.issues.values()) {
    if (!issue.parentId || issue.hiddenAt) continue;
    const list = children.get(issue.parentId) ?? [];
    list.push(issue.id);
    children.set(issue.parentId, list);
  }
  return children;
}

export function buildWatchedTrees(snapshot: CompanySnapshot): WatchedTree[] {
  const children = childrenIndex(snapshot);
  const roots: SnapshotIssue[] = [];
  for (const issue of snapshot.issues.values()) {
    if (!isOpen(issue) || issue.conversationAgentId) continue;
    const isLineRoot = snapshot.lineRootIds.has(issue.id);
    const isTopLevel = issue.parentId === null && issue.lineId === null;
    if (!isLineRoot && !isTopLevel) continue;
    if (issue.originKind && STALL_SENTINEL_EXCLUDED_ROOT_ORIGIN_KINDS.has(issue.originKind)) continue;
    roots.push(issue);
  }
  const trees: WatchedTree[] = [];
  for (const root of roots) {
    const ids = new Set<string>();
    const stack = [root.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (ids.has(id)) continue;
      ids.add(id);
      for (const child of children.get(id) ?? []) stack.push(child);
    }
    const hasAgentWork = [...ids].some((id) => {
      const issue = snapshot.issues.get(id);
      return isOpen(issue) && !!issue.assigneeAgentId;
    });
    if (!hasAgentWork) continue;
    trees.push({ rootId: root.id, issueIds: ids, isRoutine: root.originKind === ROUTINE_ORIGIN_KIND });
  }
  return trees;
}

export interface FrontierEntry {
  issueId: string;
  /** Root first, frontier last; includes blockers followed across trees. */
  path: string[];
}

/**
 * The issues that should move next: follow `blocked` issues to their open
 * blockers (also across trees) and parents to their open children.
 */
export function findFrontier(snapshot: CompanySnapshot, rootId: string): FrontierEntry[] {
  const children = childrenIndex(snapshot);
  const result = new Map<string, FrontierEntry>();
  const visit = (id: string, path: string[], seen: Set<string>) => {
    const issue = snapshot.issues.get(id);
    if (!isOpen(issue)) return;
    const nextPath = [...path, id];
    if (seen.has(id)) return;
    const nextSeen = new Set(seen).add(id);
    if (issue.status === "blocked") {
      const openBlockers = (snapshot.blockedBy.get(id) ?? []).filter((b) => isOpen(snapshot.issues.get(b)) && !nextSeen.has(b));
      if (openBlockers.length > 0) {
        for (const blocker of openBlockers) visit(blocker, nextPath, nextSeen);
        return;
      }
    } else {
      const openChildren = (children.get(id) ?? []).filter((c) => isOpen(snapshot.issues.get(c)));
      if (openChildren.length > 0) {
        for (const child of openChildren) visit(child, nextPath, nextSeen);
        return;
      }
    }
    if (!result.has(id)) result.set(id, { issueId: id, path: nextPath });
  };
  visit(rootId, [], new Set());
  return [...result.values()];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Waiting on the board: a pending card or approval, a user assignee, or a user unblock owner. */
export function isWaitingOnBoard(snapshot: CompanySnapshot, issueId: string): boolean {
  const issue = snapshot.issues.get(issueId);
  if (!issue) return false;
  if (snapshot.waitingOnBoardIssueIds.has(issueId)) return true;
  if (issue.assigneeUserId) return true;
  const owner = asRecord(issue.unblockDescriptor).owner;
  if (owner === "board") return true;
  return typeof asRecord(owner).userId === "string";
}

export function runIssueId(contextSnapshot: unknown): string | null {
  const ctx = asRecord(contextSnapshot);
  const id = ctx.issueId ?? ctx.taskId;
  return typeof id === "string" ? id : null;
}

export type SilenceRunFields = Pick<
  typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "status" | "lastOutputAt" | "lastOutputSeq" | "lastOutputStream" | "processStartedAt" | "startedAt" | "createdAt"
>;

export interface SnapshotLoaderDeps {
  db: Db;
  /** Output silence for a running run (the active-run watchdog measure). */
  measureSilence: (run: SilenceRunFields, now: Date) => Promise<number | null>;
  /** Issues with an active recovery action (`issueRecoveryActionService.listActiveForIssues`). */
  listActiveRecovery: (companyId: string, issueIds: string[]) => Promise<Set<string>>;
}

/** Reads everything one company sweep needs. Read-only. */
export async function loadCompanySnapshot(
  deps: SnapshotLoaderDeps,
  companyId: string,
  now: Date,
  lookbackMs: number,
): Promise<CompanySnapshot> {
  const { db } = deps;
  const since = new Date(now.getTime() - lookbackMs);

  const issueRows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      parentId: issues.parentId,
      lineId: issues.lineId,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      statusVersion: issues.statusVersion,
      originKind: issues.originKind,
      hiddenAt: issues.hiddenAt,
      conversationAgentId: issues.conversationAgentId,
      monitorNextCheckAt: issues.monitorNextCheckAt,
      unblockDescriptor: issues.unblockDescriptor,
      assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
      completedAt: issues.completedAt,
      cancelledAt: issues.cancelledAt,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt), isNull(issues.conversationAgentId)));
  const issueMap = new Map<string, SnapshotIssue>(issueRows.map((row) => [row.id, row as SnapshotIssue]));
  const openIds = issueRows.filter((row) => OPEN_STATUSES.has(row.status)).map((row) => row.id);

  const lineRows = await db
    .select({ rootIssueId: lines.rootIssueId })
    .from(lines)
    .where(and(eq(lines.companyId, companyId), isNull(lines.archivedAt)));

  const relationRows = await db
    .select({ blockerId: issueRelations.issueId, blockedId: issueRelations.relatedIssueId })
    .from(issueRelations)
    .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks")));
  const blocks = new Map<string, string[]>();
  const blockedBy = new Map<string, string[]>();
  for (const row of relationRows) {
    blocks.set(row.blockerId, [...(blocks.get(row.blockerId) ?? []), row.blockedId]);
    blockedBy.set(row.blockedId, [...(blockedBy.get(row.blockedId) ?? []), row.blockerId]);
  }

  // Only the columns the rules and the output-silence measure need: run rows also
  // carry logs and results, which a sweep every 2 minutes must not read.
  const runRows = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      createdAt: heartbeatRuns.createdAt,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
      processStartedAt: heartbeatRuns.processStartedAt,
      lastOutputAt: heartbeatRuns.lastOutputAt,
      lastOutputSeq: heartbeatRuns.lastOutputSeq,
      lastOutputStream: heartbeatRuns.lastOutputStream,
      issueId: sql<string | null>`coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId')`,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        or(
          inArray(heartbeatRuns.status, ["running", "queued", "scheduled_retry"]),
          gte(heartbeatRuns.createdAt, since),
        ),
      ),
    );
  const runs: SnapshotRun[] = [];
  for (const row of runRows) {
    runs.push({
      id: row.id,
      agentId: row.agentId,
      issueId: row.issueId,
      status: row.status,
      errorCode: row.errorCode,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      scheduledRetryAt: row.scheduledRetryAt,
      silenceAgeMs: row.status === "running" ? await deps.measureSilence(row, now).catch(() => null) : null,
    });
  }

  const wakeRows = await db
    .select({
      id: agentWakeupRequests.id,
      agentId: agentWakeupRequests.agentId,
      issueId: sql<string | null>`coalesce(${agentWakeupRequests.payload} ->> 'issueId', ${agentWakeupRequests.payload} ->> 'taskId')`,
      status: agentWakeupRequests.status,
      reason: agentWakeupRequests.reason,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        or(
          eq(agentWakeupRequests.status, "queued"),
          and(gte(agentWakeupRequests.requestedAt, since), sql`${agentWakeupRequests.idempotencyKey} like 'stall-sentinel:%'`),
        ),
      ),
    );
  const wakes: SnapshotWake[] = wakeRows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    issueId: row.issueId,
    status: row.status,
    reason: row.reason,
    idempotencyKey: row.idempotencyKey,
    requestedAt: row.requestedAt,
  }));

  const agentRows = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      status: agents.status,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const waitingOnBoardIssueIds = new Set<string>();
  if (openIds.length > 0) {
    const pendingInteractions = await db
      .select({ issueId: issueThreadInteractions.issueId })
      .from(issueThreadInteractions)
      .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.status, "pending")));
    for (const row of pendingInteractions) waitingOnBoardIssueIds.add(row.issueId);
    const pendingApprovals = await db
      .select({ issueId: issueApprovals.issueId })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(and(eq(issueApprovals.companyId, companyId), eq(approvals.status, "pending")));
    for (const row of pendingApprovals) waitingOnBoardIssueIds.add(row.issueId);
  }

  const labelRows = await db
    .select({ issueId: issueLabels.issueId, name: labels.name })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(eq(issueLabels.companyId, companyId));
  const labelsByIssue = new Map<string, string[]>();
  for (const row of labelRows) labelsByIssue.set(row.issueId, [...(labelsByIssue.get(row.issueId) ?? []), row.name]);

  const userOverrideRows = await db
    .select({ entityId: activityLog.entityId, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.action, "issue.updated"),
        eq(activityLog.actorType, "user"),
        gte(activityLog.createdAt, new Date(now.getTime() - 2 * 60 * 60_000)),
        sql`${activityLog.details} ? 'assigneeAdapterOverrides'`,
      ),
    );
  const lastUserOverrideAt = new Map<string, Date>();
  for (const row of userOverrideRows) {
    const prev = lastUserOverrideAt.get(row.entityId);
    if (!prev || prev < row.createdAt) lastUserOverrideAt.set(row.entityId, row.createdAt);
  }

  return {
    companyId,
    now,
    issues: issueMap,
    lineRootIds: new Set(lineRows.map((row) => row.rootIssueId)),
    blocks,
    blockedBy,
    runs,
    wakes,
    agents: new Map(agentRows.map((row) => [row.id, { ...row, adapterConfig: asRecord(row.adapterConfig) }])),
    progress: await loadIssueProgressEvents(db, companyId, since),
    waitingOnBoardIssueIds,
    activeRecoveryIssueIds: await deps.listActiveRecovery(companyId, openIds),
    labelsByIssue,
    lastUserOverrideAt,
  };
}
