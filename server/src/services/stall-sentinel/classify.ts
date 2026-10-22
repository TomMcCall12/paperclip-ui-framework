import type { ProviderQuotaSummary } from "@paperclipai/shared";
import type { StallSentinelThresholds } from "./config.js";
import { issueProgressAt, treeAgeMs, treeProgress } from "./progress.js";
import {
  effectiveAdapterType,
  evaluateProviderOut,
  planClaudeRewrite,
  providerForAdapterType,
  providerLockReason,
  type ClaudeRewritePlan,
  type ProviderLockReason,
  type ProviderSlug,
} from "./provider-switch.js";
import { deriveIssueStepKey } from "./step-key.js";
import {
  findFrontier,
  isOpen,
  isWaitingOnBoard,
  type CompanySnapshot,
  type SnapshotIssue,
  type SnapshotRun,
  type WatchedTree,
} from "./watch-units.js";

/**
 * Causes W to U (design section b) and the self-heal plan for each (section c).
 * Pure: reads the snapshot and returns findings; index.ts decides with the
 * de-duplication state whether a heal or an alert is due now.
 */

export type StallCause = "P" | "R" | "Q" | "Q2" | "L" | "A" | "C" | "B" | "K" | "D" | "U";

export type HealPlan =
  | { kind: "requeue"; agentId: string; issueId: string; reason: string }
  | { kind: "restart_after_reset"; agentId: string; issueId: string; wakeAt: Date }
  | {
      kind: "rewrite_to_claude";
      agentId: string;
      issueId: string;
      rewrite: ClaudeRewritePlan;
      previousOverrides: unknown;
      cancelRunIds: string[];
      wake: boolean;
    }
  | { kind: "cancel_stuck_run"; agentId: string; issueId: string; runId: string }
  | { kind: "cancel_duplicate"; issueId: string; keptIssueId: string }
  | { kind: "wake"; agentId: string; issueId: string; reason: string; payload: Record<string, unknown>; message?: string };

export interface StallFinding {
  cause: StallCause;
  rootId: string;
  /** The frontier issue (or the issue the cause is about). */
  issueId: string;
  path: string[];
  treeAgeMs: number;
  lastProgressAt: Date | null;
  heal: HealPlan | null;
  healDueAt: Date | null;
  /** Alert-only causes: when the alert is due. */
  alertDueAt: Date | null;
  /** Heal causes: alert this long after the heal if the condition still holds. */
  afterHealAlertMs: number | null;
  /** Silent heals never alert (the OpenAI-to-Claude rewrite). */
  silent: boolean;
  repeat: "hourly" | "once";
  reasonKey: string | null;
  data: FindingData;
}

export interface FindingData {
  provider?: ProviderSlug;
  resetsAt?: Date | null;
  providerOut?: boolean;
  lockReason?: ProviderLockReason | null;
  agentId?: string | null;
  runId?: string | null;
  ranForMs?: number;
  busyRunId?: string;
  busyIssueId?: string | null;
  busySince?: Date | null;
  queuedSince?: Date;
  agentState?: string;
  blockerId?: string;
  childId?: string;
  childFinishedAt?: Date | null;
  duplicateIds?: [string, string];
  stepId?: string;
}

export interface ClassifyContext {
  thresholds: StallSentinelThresholds;
  quota: Map<string, ProviderQuotaSummary>;
  lookbackMs: number;
}

const ACTIVE_RUN_STATUSES = new Set(["running"]);
const PENDING_RUN_STATUSES = new Set(["queued", "scheduled_retry"]);
const UNAVAILABLE_AGENT_STATUSES = new Set(["paused", "error", "terminated"]);

function addMs(date: Date, ms: number) {
  return new Date(date.getTime() + ms);
}

function runsForIssue(snapshot: CompanySnapshot, issueId: string) {
  return snapshot.runs.filter((run) => run.issueId === issueId);
}

function latestFinishedRun(runs: SnapshotRun[]): SnapshotRun | null {
  let latest: SnapshotRun | null = null;
  for (const run of runs) {
    if (!run.finishedAt) continue;
    if (!latest || run.finishedAt > latest.finishedAt!) latest = run;
  }
  return latest;
}

function timeoutSecFor(snapshot: CompanySnapshot, issue: SnapshotIssue, agentId: string): number {
  const overrides = issue.assigneeAdapterOverrides as { adapterConfig?: Record<string, unknown> } | null;
  const fromIssue = overrides?.adapterConfig?.timeoutSec;
  const fromAgent = snapshot.agents.get(agentId)?.adapterConfig.timeoutSec;
  const value = typeof fromIssue === "number" ? fromIssue : typeof fromAgent === "number" ? fromAgent : 0;
  return value > 0 ? value : 0;
}

interface BaseFields {
  rootId: string;
  path: string[];
  treeAgeMs: number;
  lastProgressAt: Date | null;
  scale: number;
}

function finding(base: BaseFields, issueId: string, cause: StallCause, rest: Partial<StallFinding>): StallFinding {
  return {
    cause,
    rootId: base.rootId,
    issueId,
    path: base.path,
    treeAgeMs: base.treeAgeMs,
    lastProgressAt: base.lastProgressAt,
    heal: null,
    healDueAt: null,
    alertDueAt: null,
    afterHealAlertMs: null,
    silent: false,
    repeat: "hourly",
    reasonKey: null,
    data: {},
    ...rest,
  };
}

/** Provider rule for one issue (row 1, as amended: never Claude to OpenAI). */
function classifyProvider(
  snapshot: CompanySnapshot,
  issue: SnapshotIssue,
  base: BaseFields,
  ctx: ClassifyContext,
): StallFinding | null {
  const agentId = issue.assigneeAgentId;
  if (!agentId) return null;
  const agent = snapshot.agents.get(agentId);
  if (!agent) return null;
  const now = snapshot.now;
  const runs = runsForIssue(snapshot, issue.id);
  const latest = latestFinishedRun(runs);
  const hasRunning = runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));
  const pending = runs.filter((run) => PENDING_RUN_STATUSES.has(run.status));
  const queuedWakes = snapshot.wakes.filter((wake) => wake.issueId === issue.id && wake.status === "queued");
  const adapterType = effectiveAdapterType(agent.adapterType, issue.assigneeAdapterOverrides);
  const provider = providerForAdapterType(adapterType);
  if (!provider) return null;
  const outState = evaluateProviderOut(ctx.quota.get(provider), now);
  const quotaFailed =
    latest?.errorCode === "provider_quota" &&
    !runs.some((run) => run.status === "succeeded" && run.finishedAt && run.finishedAt > latest.finishedAt!);
  const waitingOnOutProvider = outState.out && (pending.length > 0 || queuedWakes.length > 0);
  if (hasRunning || (!quotaFailed && !waitingOnOutProvider)) return null;

  const lockReason = providerLockReason({
    agentAdapterType: agent.adapterType,
    overrides: issue.assigneeAdapterOverrides,
    labelNames: snapshot.labelsByIssue.get(issue.id) ?? [],
    lastUserOverrideAt: snapshot.lastUserOverrideAt.get(issue.id) ?? null,
    now,
  });
  const data: FindingData = { provider, resetsAt: outState.resetsAt, providerOut: outState.out, lockReason, agentId };

  // OpenAI stall on a Claude-based agent: move the task back to Claude.
  const rewrite = lockReason ? null : planClaudeRewrite(agent.adapterType, issue.assigneeAdapterOverrides);
  if (rewrite) {
    return finding(base, issue.id, "P", {
      heal: {
        kind: "rewrite_to_claude",
        agentId,
        issueId: issue.id,
        rewrite,
        previousOverrides: issue.assigneeAdapterOverrides,
        cancelRunIds: pending.map((run) => run.id),
        wake: true,
      },
      healDueAt: now,
      silent: true,
      data,
    });
  }
  // A Codex agent with no Claude override: the step must stay with that agent.
  if (lockReason === "codex_agent") {
    return finding(base, issue.id, "P", {
      alertDueAt: now,
      repeat: "once",
      data,
    });
  }
  // Wait for the reset: one wake at resetsAt + 5 minutes, unless one already exists.
  const resetsAt = outState.resetsAt;
  const hasScheduled = pending.length > 0 || queuedWakes.length > 0;
  const reasonKey = resetsAt ? `provider:${provider}:${resetsAt.toISOString()}` : null;
  if (!resetsAt) {
    return finding(base, issue.id, "U", {
      alertDueAt: addMs(base.lastProgressAt ?? now, ctx.thresholds.unknownAlertMs * base.scale),
      data,
    });
  }
  const restartAt = addMs(resetsAt, ctx.thresholds.providerRestartDelayMs);
  return finding(base, issue.id, "P", {
    heal: hasScheduled ? null : { kind: "restart_after_reset", agentId, issueId: issue.id, wakeAt: restartAt },
    healDueAt: hasScheduled ? null : now,
    alertDueAt: outState.out ? now : addMs(resetsAt, ctx.thresholds.providerRestartAlertGraceMs),
    reasonKey,
    data,
  });
}

/** Proactive pass: any open task a Claude agent would run on OpenAI is moved back to Claude. */
function classifyOpenAiOverrides(snapshot: CompanySnapshot, tree: WatchedTree, base: Omit<BaseFields, "path">) {
  const result: StallFinding[] = [];
  for (const id of tree.issueIds) {
    const issue = snapshot.issues.get(id);
    if (!isOpen(issue) || !issue.assigneeAgentId) continue;
    if (isWaitingOnBoard(snapshot, id)) continue;
    const agent = snapshot.agents.get(issue.assigneeAgentId);
    if (!agent) continue;
    const runs = runsForIssue(snapshot, id);
    if (runs.some((run) => run.status === "running")) continue;
    const lockReason = providerLockReason({
      agentAdapterType: agent.adapterType,
      overrides: issue.assigneeAdapterOverrides,
      labelNames: snapshot.labelsByIssue.get(id) ?? [],
      lastUserOverrideAt: snapshot.lastUserOverrideAt.get(id) ?? null,
      now: snapshot.now,
    });
    if (lockReason) continue;
    const rewrite = planClaudeRewrite(agent.adapterType, issue.assigneeAdapterOverrides);
    if (!rewrite) continue;
    const pending = runs.filter((run) => PENDING_RUN_STATUSES.has(run.status));
    const latest = latestFinishedRun(runs);
    result.push(
      finding({ ...base, path: [tree.rootId, id] }, id, "P", {
        heal: {
          kind: "rewrite_to_claude",
          agentId: agent.id,
          issueId: id,
          rewrite,
          previousOverrides: issue.assigneeAdapterOverrides,
          cancelRunIds: pending.map((run) => run.id),
          wake: pending.length > 0 || latest?.errorCode === "provider_quota",
        },
        healDueAt: snapshot.now,
        silent: true,
        data: { provider: "openai", agentId: agent.id },
      }),
    );
  }
  return result;
}

function classifyFrontierIssue(
  snapshot: CompanySnapshot,
  issue: SnapshotIssue,
  base: BaseFields,
  ctx: ClassifyContext,
): StallFinding | null {
  const t = ctx.thresholds;
  const m = base.scale;
  const now = snapshot.now;
  const since = base.lastProgressAt ?? now;
  const agentId = issue.assigneeAgentId;
  const agent = agentId ? snapshot.agents.get(agentId) : undefined;

  const provider = classifyProvider(snapshot, issue, base, ctx);
  if (provider) return provider;

  const runs = runsForIssue(snapshot, issue.id);
  const running = runs.find((run) => run.status === "running");
  if (running && agentId) {
    const startedAt = running.startedAt ?? running.createdAt;
    const ranForMs = now.getTime() - startedAt.getTime();
    const timeoutSec = timeoutSecFor(snapshot, issue, running.agentId);
    const silent = running.silenceAgeMs != null && running.silenceAgeMs >= t.stuckSilenceMs;
    const overTime = timeoutSec > 0 && ranForMs > timeoutSec * 1000 + t.stuckTimeoutGraceMs;
    if (!silent && !overTime) return null;
    return finding(base, issue.id, "R", {
      heal: { kind: "cancel_stuck_run", agentId: running.agentId, issueId: issue.id, runId: running.id },
      healDueAt: now,
      afterHealAlertMs: t.stuckSilenceMs,
      data: { runId: running.id, ranForMs, agentId: running.agentId },
    });
  }

  // An agent in `error` (for example after a deploy restart killed its run) still starts its
  // retry run. Do not alert while it has a run or wake waiting for this issue, or runs elsewhere.
  const errorAgentWillRun =
    agent?.status === "error" &&
    (runs.some((run) => PENDING_RUN_STATUSES.has(run.status)) ||
      snapshot.wakes.some((wake) => wake.issueId === issue.id && wake.status === "queued") ||
      snapshot.runs.some((run) => run.agentId === agent.id && ACTIVE_RUN_STATUSES.has(run.status)));
  if (agent && UNAVAILABLE_AGENT_STATUSES.has(agent.status) && !errorAgentWillRun) {
    return finding(base, issue.id, "A", {
      alertDueAt: addMs(since, t.agentUnavailableAlertMs * m),
      reasonKey: `paused:${agent.id}`,
      data: { agentId: agent.id, agentState: agent.status === "paused" ? "paused" : "in error" },
    });
  }

  const pendingRuns = runs.filter((run) => PENDING_RUN_STATUSES.has(run.status));
  const queuedWakes = snapshot.wakes.filter((wake) => wake.issueId === issue.id && wake.status === "queued");
  // Blocked tasks hold their wakes until unblocked, so queued work only counts for runnable tasks.
  const runnable = issue.status !== "blocked";
  if (agentId && runnable && (pendingRuns.length > 0 || queuedWakes.length > 0)) {
    // A scheduled retry in the future is a planned wait, not a stall.
    const due = pendingRuns.filter((run) => run.status === "queued" || !run.scheduledRetryAt || run.scheduledRetryAt <= now);
    if (due.length === 0 && queuedWakes.length === 0) return null;
    const queuedTimes = [
      ...due.map((run) => run.scheduledRetryAt ?? run.createdAt),
      ...queuedWakes.map((wake) => wake.requestedAt),
    ];
    const queuedSince = new Date(Math.min(...queuedTimes.map((d) => d.getTime())));
    const busyRun = snapshot.runs.find(
      (run) => run.agentId === agentId && run.status === "running" && run.issueId !== issue.id,
    );
    if (busyRun) {
      return finding(base, issue.id, "Q", {
        alertDueAt: addMs(queuedSince, t.busyQueuedAlertMs * m),
        reasonKey: `busy:${agentId}:${busyRun.id}`,
        data: {
          agentId,
          busyRunId: busyRun.id,
          busyIssueId: busyRun.issueId,
          busySince: busyRun.startedAt ?? busyRun.createdAt,
          queuedSince,
        },
      });
    }
    return finding(base, issue.id, "Q2", {
      heal: { kind: "requeue", agentId, issueId: issue.id, reason: "stall_sentinel_requeue" },
      healDueAt: addMs(queuedSince, t.idleQueuedHealMs * m),
      afterHealAlertMs: t.afterRequeueAlertMs * m,
      data: { agentId, queuedSince },
    });
  }

  if (agentId && ["todo", "in_progress", "in_review"].includes(issue.status)) {
    let healDueAt = addMs(since, t.lostRunHealMs * m);
    if (issue.monitorNextCheckAt) {
      const monitorDue = addMs(issue.monitorNextCheckAt, t.monitorGraceMs);
      if (now < monitorDue) return null;
      if (monitorDue > healDueAt) healDueAt = monitorDue;
    }
    return finding(base, issue.id, "L", {
      heal: { kind: "requeue", agentId, issueId: issue.id, reason: "stall_sentinel_requeue" },
      healDueAt,
      afterHealAlertMs: t.afterRequeueAlertMs * m,
      data: { agentId },
    });
  }

  if (issue.status === "blocked") {
    const blockerIds = snapshot.blockedBy.get(issue.id) ?? [];
    const cancelled = blockerIds
      .map((id) => snapshot.issues.get(id))
      .find((blocker) => blocker?.status === "cancelled");
    if (cancelled) {
      const parent = issue.parentId ? snapshot.issues.get(issue.parentId) : undefined;
      const owner = parent?.assigneeAgentId ?? issue.assigneeAgentId;
      const cancelledAt = cancelled.cancelledAt ?? cancelled.updatedAt;
      return finding(base, issue.id, "C", {
        heal: owner
          ? {
              kind: "wake",
              agentId: owner,
              issueId: parent?.assigneeAgentId ? parent.id : issue.id,
              reason: "stall_sentinel_cancelled_blocker",
              payload: { dependentIssueId: issue.id, cancelledBlockerIssueId: cancelled.id },
              message: `${issue.identifier ?? issue.id} waits for ${cancelled.identifier ?? cancelled.id}, which was cancelled. Replace or remove that blocker.`,
            }
          : null,
        healDueAt: owner ? addMs(cancelledAt, t.cancelledBlockerHealMs * m) : null,
        alertDueAt: owner ? null : addMs(cancelledAt, t.cancelledBlockerHealMs * m),
        afterHealAlertMs: t.afterWakeAlertMs * m,
        data: { blockerId: cancelled.id, agentId: owner ?? null },
      });
    }
    const owner = (issue.unblockDescriptor as { owner?: unknown } | null)?.owner;
    if (blockerIds.length === 0 && !owner) {
      return finding(base, issue.id, "B", {
        heal: agentId
          ? {
              kind: "wake",
              agentId,
              issueId: issue.id,
              reason: "stall_sentinel_blocked_without_blocker",
              payload: {},
              message: "This task is blocked but names no blocker. Set blockedByIssueIds to the task you are waiting for, or carry on.",
            }
          : null,
        healDueAt: agentId ? addMs(since, t.blockedWithoutBlockerHealMs * m) : null,
        alertDueAt: agentId ? null : addMs(since, t.blockedWithoutBlockerHealMs * m),
        afterHealAlertMs: t.afterWakeAlertMs * m,
        data: { agentId: agentId ?? null },
      });
    }
  }

  return finding(base, issue.id, "U", {
    alertDueAt: addMs(since, base.scale > 1 ? t.routineUnknownAlertMs : t.unknownAlertMs),
  });
}

/** Checkpoint rule (K): a child finished, its parent is blocked on it with other blockers open, and the parent was not woken. */
function classifyCheckpoints(snapshot: CompanySnapshot, tree: WatchedTree, base: Omit<BaseFields, "path">, ctx: ClassifyContext) {
  const result: StallFinding[] = [];
  for (const id of tree.issueIds) {
    const parent = snapshot.issues.get(id);
    if (!isOpen(parent) || parent.status !== "blocked" || !parent.assigneeAgentId) continue;
    if (isWaitingOnBoard(snapshot, id)) continue;
    const blockers = (snapshot.blockedBy.get(id) ?? []).map((b) => snapshot.issues.get(b)).filter(Boolean) as SnapshotIssue[];
    const openBlockers = blockers.filter((b) => isOpen(b));
    if (openBlockers.length === 0) continue;
    const parentRuns = runsForIssue(snapshot, id);
    for (const child of blockers) {
      if (child.status !== "done" || child.parentId !== id) continue;
      const finishedAt = child.completedAt ?? child.updatedAt;
      if (snapshot.now.getTime() - finishedAt.getTime() > ctx.thresholds.oldStallMs) continue;
      const pickedUp = parentRuns.some((run) => (run.startedAt ?? run.createdAt) >= finishedAt);
      if (pickedUp) continue;
      result.push(
        finding({ ...base, path: [tree.rootId, id] }, id, "K", {
          heal: {
            kind: "wake",
            agentId: parent.assigneeAgentId,
            issueId: id,
            reason: "stall_sentinel_checkpoint_done",
            payload: { finishedChildIssueId: child.id },
            message: `Step ${child.identifier ?? child.id} finished. Check it and hand on the next step.`,
          },
          healDueAt: addMs(finishedAt, ctx.thresholds.checkpointHealMs * base.scale),
          afterHealAlertMs: ctx.thresholds.afterWakeAlertMs * base.scale,
          data: { agentId: parent.assigneeAgentId, childId: child.id, childFinishedAt: finishedAt },
        }),
      );
    }
  }
  return result;
}

/** Duplicate rule (D): two open siblings with the same step key. */
function classifyDuplicates(snapshot: CompanySnapshot, tree: WatchedTree, base: Omit<BaseFields, "path">) {
  const byKey = new Map<string, SnapshotIssue[]>();
  for (const id of tree.issueIds) {
    const issue = snapshot.issues.get(id);
    if (!isOpen(issue)) continue;
    const key = deriveIssueStepKey(issue.parentId, issue.title);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), issue]);
  }
  const result: StallFinding[] = [];
  for (const [key, copies] of byKey) {
    if (copies.length < 2) continue;
    const sorted = [...copies].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const kept = sorted[0]!;
    const newer = sorted[sorted.length - 1]!;
    const hasRun = snapshot.runs.some((run) => run.issueId === newer.id);
    const hasWork = snapshot.progress.issuesWithWork.has(newer.id);
    const blocksOthers = (snapshot.blocks.get(newer.id) ?? []).some((id) => isOpen(snapshot.issues.get(id)));
    const safe = !hasRun && !hasWork && !blocksOthers && kept.parentId === newer.parentId;
    const stepId = key.slice(key.lastIndexOf(":") + 1);
    result.push(
      finding({ ...base, path: [tree.rootId, newer.id] }, newer.id, "D", {
        heal: safe ? { kind: "cancel_duplicate", issueId: newer.id, keptIssueId: kept.id } : null,
        healDueAt: safe ? snapshot.now : null,
        alertDueAt: safe ? null : snapshot.now,
        data: { duplicateIds: [kept.id, newer.id], stepId },
      }),
    );
  }
  return result;
}

export interface TreeClassification {
  tree: WatchedTree;
  lastProgressAt: Date | null;
  lastProgressIssueId: string | null;
  treeAgeMs: number;
  findings: StallFinding[];
}

export function classifyTree(snapshot: CompanySnapshot, tree: WatchedTree, ctx: ClassifyContext): TreeClassification {
  const progress = treeProgress(snapshot, tree);
  const ageMs = treeAgeMs(progress, snapshot.now, ctx.lookbackMs);
  const base = {
    rootId: tree.rootId,
    treeAgeMs: ageMs,
    lastProgressAt: progress.at,
    scale: tree.isRoutine ? 2 : 1,
  };
  const findings: StallFinding[] = [];
  const seen = new Set<string>();
  const push = (f: StallFinding | null) => {
    if (!f) return;
    const key = `${f.cause}:${f.issueId}:${f.data.childId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };

  for (const f of classifyOpenAiOverrides(snapshot, tree, base)) push(f);
  for (const f of classifyDuplicates(snapshot, tree, base)) push(f);
  for (const f of classifyCheckpoints(snapshot, tree, base, ctx)) push(f);

  for (const entry of findFrontier(snapshot, tree.rootId)) {
    if (entry.path.some((id) => isWaitingOnBoard(snapshot, id))) continue;
    const issue = snapshot.issues.get(entry.issueId);
    if (!issue) continue;
    const f = classifyFrontierIssue(snapshot, issue, { ...base, path: entry.path }, ctx);
    if (f && f.cause === "P" && f.heal?.kind === "rewrite_to_claude" && seen.has(`P:${f.issueId}:`)) continue;
    push(f);
  }

  // The recovery loop owns issues with an active recovery action: no heal; only the backstop alert.
  for (const f of findings) {
    if (!f.heal || !snapshot.activeRecoveryIssueIds.has(f.heal.issueId)) continue;
    f.heal = null;
    f.healDueAt = null;
    f.silent = false;
    f.alertDueAt = new Date((f.lastProgressAt ?? snapshot.now).getTime() + ctx.thresholds.unknownAlertMs * base.scale);
  }
  return {
    tree,
    lastProgressAt: progress.at,
    lastProgressIssueId: progress.issueId,
    treeAgeMs: ageMs,
    findings,
  };
}

export { issueProgressAt };
