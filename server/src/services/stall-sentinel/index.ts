import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import type { ProviderQuotaSummary } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { logger } from "../../middleware/logger.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { createQuotaVaultCredentialResolver } from "../quota-vault-credential.js";
import { fetchAllQuotaWindows, summarizeQuotaWindows } from "../quota-windows.js";
import { createStallSentinelActions, type HeartbeatWakePort, type StallSentinelActions } from "./actions.js";
import {
  formatAge,
  formatAt,
  formatTime,
  issueRef,
  leafLabel,
  renderAlert,
  templates,
  type AlertParts,
  type RenderContext,
} from "./alerts.js";
import { classifyTree, type StallFinding } from "./classify.js";
import {
  readStallSentinelConfig,
  resolveEffectiveMode,
  type StallSentinelConfig,
  type StallSentinelMode,
} from "./config.js";
import {
  alertIsDue,
  emptyMemory,
  healKey,
  loadMemoryRows,
  loadRolloutState,
  nextRepeatAt,
  rebuildMemory,
  recentHeal,
  rootGapOk,
  SENTINEL_ACTIONS,
  stallFingerprint,
  telegramAllowed,
  type ActivityStateRow,
  type CompanyMemory,
  type RolloutState,
} from "./dedupe.js";
import { updateStallSentinelHealth } from "./health-state.js";
import { createQuotaCache, evaluateProviderOut, providerDisplayName } from "./provider-switch.js";
import {
  buildWatchedTrees,
  loadCompanySnapshot,
  type CompanySnapshot,
  type SilenceRunFields,
  type SnapshotAgent,
} from "./watch-units.js";

/**
 * Stall sentinel (TOM-713): a server-side sweep, every 2 minutes, that finds
 * work trees with no progress, fixes the simple causes itself, and tells the
 * board on Telegram in plain English when it cannot. It calls no model and no
 * agent adapter. Design: doc/stall-sentinel.md.
 */

export interface StallSentinelStore {
  listCompanyIds(): Promise<string[]>;
  loadSnapshot(companyId: string, now: Date, lookbackMs: number): Promise<CompanySnapshot>;
  loadMemoryRows(companyId: string, since: Date): Promise<ActivityStateRow[]>;
  loadRollout(companyId: string): Promise<RolloutState>;
}

export interface StallSentinelPersistence {
  readLastSweepAt(): Date | null;
  writeLastSweepAt(at: Date): void;
}

export interface StallSentinelDeps {
  store: StallSentinelStore;
  actions: StallSentinelActions;
  fetchQuota: (companyId: string) => Promise<ProviderQuotaSummary[]>;
  resolveSchedulingSuppression: () => Promise<{ suppressed: boolean }>;
  persistence: StallSentinelPersistence;
  config?: StallSentinelConfig;
  now?: () => Date;
}

export interface SweepResult {
  skipped: boolean;
  companies: number;
  heals: number;
  wouldHeals: number;
  alerts: number;
  telegrams: number;
}

interface CompanyState {
  memory: CompanyMemory;
  rollout: RolloutState;
  /** Fingerprint of the current hold alert. */
  holdSince: Date | null;
  failureAlertSent: boolean;
}

type PendingAlert = {
  rootId: string;
  rootTitle: string;
  rid: string;
  fingerprint: string;
  finding: StallFinding | null;
  cause: string;
  reasonKey: string | null;
  repeat: "hourly" | "once";
  build: (fields: { root: string; listLimit: number }) => AlertParts;
  /** Alert-only wording applies (a heal would have been made). */
  alertOnly: boolean;
  mentionCoordinator: boolean;
  stalledSince: Date | null;
  treeAgeMs: number;
  group?: { reason: string; did: string; next: string; action: string | null };
};

function coordinatorMention(agent: SnapshotAgent) {
  return `[@${agent.name}](agent://${agent.id})`;
}

/**
 * The latest moment of a run on this issue that started at or after `at` (a requeue that worked,
 * even if it already finished): its finish, start or creation. Null when no such run exists.
 */
function lastRunActivitySince(snapshot: CompanySnapshot, issueId: string, at: Date): Date | null {
  let latest: Date | null = null;
  for (const run of snapshot.runs) {
    if (run.issueId !== issueId) continue;
    if (!(run.createdAt >= at || (run.startedAt != null && run.startedAt >= at))) continue;
    for (const t of [run.createdAt, run.startedAt, run.finishedAt]) {
      if (t && (!latest || t > latest)) latest = t;
    }
  }
  return latest;
}

/**
 * Alert-only mode never heals, so the alert comes at the cause's own alert time:
 * the fixed alert time, or the heal-due time plus the wait that follows a heal.
 * A stuck run is already the evidence, so it alerts when it is found.
 */
function alertOnlyAlertIsDue(f: StallFinding, now: Date): boolean {
  if (f.silent || !f.heal || f.heal.kind === "cancel_duplicate") return false;
  let at = f.alertDueAt;
  if (!at && f.healDueAt) {
    at = f.cause === "R" || f.afterHealAlertMs == null ? f.healDueAt : new Date(f.healDueAt.getTime() + f.afterHealAlertMs);
  }
  return !!at && now >= at;
}

export function resolveCoordinator(snapshot: CompanySnapshot, config: StallSentinelConfig): SnapshotAgent | null {
  if (config.coordinatorAgentId) {
    const byId = snapshot.agents.get(config.coordinatorAgentId);
    if (byId) return byId;
  }
  const name = config.coordinatorAgentName.toLowerCase();
  for (const agent of snapshot.agents.values()) {
    if (agent.name.toLowerCase() === name && agent.status !== "terminated") return agent;
  }
  return null;
}

export function createStallSentinel(deps: StallSentinelDeps) {
  const config = deps.config ?? readStallSentinelConfig();
  const clock = deps.now ?? (() => new Date());
  const quota = createQuotaCache(deps.fetchQuota);
  const states = new Map<string, CompanyState>();
  const startedAt = clock();
  let sweeping = false;
  let lastSweepStartedAt: Date | null = null;
  let consecutiveFailures = 0;
  let gapChecked = false;
  let lastAlertAt: string | null = null;
  let lastDeliveryError: string | null = null;
  /** Companies from the last good sweep, so a failure notice still has somewhere to go. */
  let knownCompanyIds: string[] = [];

  updateStallSentinelHealth({
    mode: config.mode,
    effectiveMode: config.mode === "on" ? "alert_only" : config.mode,
    startedAt: startedAt.toISOString(),
    lastSweepAt: null,
    lastSweepOk: true,
    consecutiveFailures: 0,
  });

  async function companyState(companyId: string, now: Date): Promise<CompanyState> {
    let state = states.get(companyId);
    if (!state) {
      const rows = await deps.store.loadMemoryRows(companyId, new Date(now.getTime() - config.thresholds.healCooldownMs));
      state = {
        memory: rows.length > 0 ? rebuildMemory(rows) : emptyMemory(),
        rollout: await deps.store.loadRollout(companyId),
        holdSince: null,
        failureAlertSent: false,
      };
      states.set(companyId, state);
    }
    return state;
  }

  async function sendTelegram(companyId: string, state: CompanyState, text: string, now: Date, force = false) {
    if (!force && !telegramAllowed(state.memory, now, config.companyTelegramCapPerHour)) {
      state.memory.capOverflow += 1;
      return { sent: false, reason: "rate_limited" };
    }
    const result = await deps.actions.telegram(companyId, text);
    if (result.sent) {
      state.memory.telegramSends.push(now);
      lastAlertAt = now.toISOString();
    } else {
      lastDeliveryError = result.reason ?? "not_sent";
    }
    return result;
  }

  async function companyNotice(companyId: string, state: CompanyState, text: string, template: string, now: Date) {
    const result = await sendTelegram(companyId, state, text, now, true);
    await deps.actions.activity({
      companyId,
      action: SENTINEL_ACTIONS.alerted,
      entityType: "company",
      entityId: companyId,
      details: { template, sent: result.sent, ...(result.reason ? { deliveryError: result.reason } : {}) },
    });
  }

  async function sweepCompany(
    companyId: string,
    now: Date,
    totals: SweepResult,
    opts: { gapFrom: Date | null; suppressed: boolean; run: { aborted: boolean } },
  ) {
    const state = await companyState(companyId, now);
    const mem = state.memory;
    const renderBase: RenderContext = { alertOnly: null };

    // Rollout guard: `on` is alert-only for the first 24 hours after the first sweep.
    let digestSweep = false;
    if (config.mode === "on" && !state.rollout.startedAt) {
      state.rollout = { startedAt: now, selfRepairOnAt: null };
      digestSweep = true;
      await deps.actions.activity({
        companyId,
        action: SENTINEL_ACTIONS.rollout,
        entityType: "company",
        entityId: companyId,
        details: { phase: "started", startedAt: now.toISOString(), rolloutHours: config.rolloutMs / 3_600_000 },
      });
    }
    const effectiveMode: StallSentinelMode = resolveEffectiveMode(config.mode, state.rollout.startedAt, config.rolloutMs, now);
    const selfRepairAt = state.rollout.startedAt ? new Date(state.rollout.startedAt.getTime() + config.rolloutMs) : null;
    const alertOnlyCtx: RenderContext = {
      alertOnly: { selfRepairFrom: config.mode === "on" && selfRepairAt ? formatTime(selfRepairAt, now) : null },
    };
    if (config.mode === "on" && effectiveMode === "on" && !state.rollout.selfRepairOnAt) {
      state.rollout.selfRepairOnAt = now;
      await deps.actions.activity({
        companyId,
        action: SENTINEL_ACTIONS.rollout,
        entityType: "company",
        entityId: companyId,
        details: { phase: "self_repair_on", stalls: mem.alertOnlyStalls.size, fixes: mem.alertOnlyFixes },
      });
      await sendTelegram(
        companyId,
        state,
        renderAlert(templates.T16({ stalls: mem.alertOnlyStalls.size, fixes: mem.alertOnlyFixes }), "", renderBase),
        now,
        true,
      );
    }

    if (opts.gapFrom) {
      const text = renderAlert(
        templates.T17({
          from: formatTime(opts.gapFrom, now),
          to: formatTime(now, now),
          gap: formatAge(now.getTime() - opts.gapFrom.getTime()),
        }),
        "",
        renderBase,
      );
      await companyNotice(companyId, state, text, "T17", now);
    }

    // All runs held: one company-level alert after an hour, nothing per tree.
    if (opts.suppressed) {
      state.holdSince ??= now;
      const holdAge = now.getTime() - state.holdSince.getTime();
      const fingerprint = stallFingerprint(companyId, companyId, "H", companyId);
      if (holdAge >= config.thresholds.holdAlertMs && alertIsDue(mem, fingerprint, now, holdAge, config.thresholds.alertRepeatMs, config.thresholds.oldStallMs)) {
        const text = renderAlert(
          templates.T11({ age: formatAge(holdAge), atNext: formatAt(new Date(now.getTime() + config.thresholds.alertRepeatMs), now) }),
          "",
          renderBase,
        );
        await companyNotice(companyId, state, text, "T11", now);
        mem.alerts.set(fingerprint, { firstAt: now, lastSentAt: now, rootId: companyId, cause: "H", repeat: "hourly" });
        totals.alerts += 1;
      }
      return;
    }
    state.holdSince = null;

    const snapshot = await deps.store.loadSnapshot(companyId, now, config.thresholds.progressLookbackMs);
    const quotaMap = await quota(companyId, now);
    // The 60 second limit passed while this sweep was reading: stop before it acts on old data.
    if (opts.run.aborted) return;
    const coordinator = resolveCoordinator(snapshot, config);
    const coordinatorOut = (() => {
      if (!coordinator) return false;
      const provider = coordinator.adapterType === "claude_local" ? "anthropic" : coordinator.adapterType === "codex_local" ? "openai" : null;
      return provider ? evaluateProviderOut(quotaMap.get(provider), now).out : false;
    })();
    const issue = (id: string) => snapshot.issues.get(id);
    const agentName = (id: string | null | undefined) => (id ? snapshot.agents.get(id)?.name ?? "its agent" : "its agent");
    const ref = (id: string) => {
      const row = issue(id);
      return row ? issueRef(row) : id.slice(0, 8);
    };
    const leaf = (id: string) => {
      const row = issue(id);
      return row ? leafLabel(row) : id.slice(0, 8);
    };

    const pending: PendingAlert[] = [];
    const stalledRoots = new Set<string>();
    const progressByRoot = new Map<string, { at: Date | null; issueId: string | null }>();
    const trees = buildWatchedTrees(snapshot);

    for (const tree of trees) {
      const classification = classifyTree(snapshot, tree, {
        thresholds: config.thresholds,
        quota: quotaMap,
        lookbackMs: config.thresholds.progressLookbackMs,
      });
      progressByRoot.set(tree.rootId, { at: classification.lastProgressAt, issueId: classification.lastProgressIssueId });
      const root = issue(tree.rootId)!;

      for (const f of classification.findings) {
        const fingerprint = stallFingerprint(companyId, f.rootId, f.cause, f.issueId);
        const subject = f.data.childId ?? null;
        // A lost run (L) and a queued run that never started (Q2) share one restart:
        // after the wake is queued, the same task looks "queued" and must not be restarted twice.
        // A Claude rewrite and a wait for the reset are different heals and keep separate keys.
        const healCause =
          f.cause === "L" || f.cause === "Q2"
            ? "requeue"
            : f.cause === "P"
              ? f.heal?.kind === "rewrite_to_claude"
                ? "P:rewrite"
                : "P:restart"
              : f.cause;
        const hk = healKey(f.heal?.issueId ?? f.issueId, healCause, subject);
        const recorded = recentHeal(mem, hk, now, config.thresholds.healCooldownMs);
        // A would-have-healed note from the alert-only window never blocks a real heal.
        const prior = recorded && !recorded.applied && effectiveMode === "on" ? null : recorded;
        let alertNow = false;
        let alertOnlyWording = false;
        let ranAgain = false;
        let healedAt: Date | null = prior?.at ?? null;
        const notAsked = !!prior?.applied && prior.asked === false;

        if (f.heal) {
          // A scheduled provider restart fires once when its time comes.
          if (f.heal.kind === "restart_after_reset" && prior?.applied && prior.wakeAt && now >= prior.wakeAt) {
            await fireScheduledRestart(companyId, snapshot, f, prior.wakeAt, root.id);
          }
          const healDue = !!f.healDueAt && now >= f.healDueAt;
          if (!prior) {
            if (healDue) {
              stalledRoots.add(f.rootId);
              if (effectiveMode === "on") {
                await applyHeal(companyId, snapshot, f, root.id, hk, now);
                totals.heals += 1;
                healedAt = now;
                if (f.cause === "P" && !f.silent && f.alertDueAt && now >= f.alertDueAt) alertNow = true;
              } else {
                await recordWouldHeal(companyId, snapshot, f, root.id, hk, now, alertOnlyCtx);
                totals.wouldHeals += 1;
                alertNow = alertOnlyAlertIsDue(f, now);
                alertOnlyWording = alertNow;
              }
            }
          } else if (!f.silent) {
            if (!prior.applied) {
              // Alert-only: nothing was done, so the alert comes at the cause's own alert time.
              if (healDue) stalledRoots.add(f.rootId);
              alertNow = alertOnlyAlertIsDue(f, now);
              alertOnlyWording = alertNow;
            } else if (f.cause === "P") {
              stalledRoots.add(f.rootId);
              alertNow = !!f.alertDueAt && now >= f.alertDueAt;
            } else if (f.afterHealAlertMs != null && healDue) {
              // The heal was made, but the condition still holds.
              const ranSince =
                f.cause === "L" || f.cause === "Q2" ? lastRunActivitySince(snapshot, f.heal.issueId, prior.at) : null;
              if (!ranSince) {
                stalledRoots.add(f.rootId);
                if (now.getTime() - prior.at.getTime() >= f.afterHealAlertMs) alertNow = true;
              } else {
                // The requeue started a run, so it worked, and this is a new stall. The heal limit
                // stops a second requeue, so the clock restarts with that run and the alert comes
                // when it would have come after a heal.
                const stalledFrom = f.healDueAt && f.healDueAt > ranSince ? f.healDueAt : ranSince;
                if (now >= stalledFrom) {
                  stalledRoots.add(f.rootId);
                  if (now.getTime() - stalledFrom.getTime() >= f.afterHealAlertMs) {
                    alertNow = true;
                    ranAgain = true;
                  }
                }
              }
            }
          }
        } else if (f.alertDueAt && now >= f.alertDueAt) {
          stalledRoots.add(f.rootId);
          alertNow = true;
        }
        if (!alertNow) continue;
        if (!alertIsDue(mem, fingerprint, now, f.treeAgeMs, config.thresholds.alertRepeatMs, config.thresholds.oldStallMs)) continue;

        const built = buildFindingAlert(f, {
          now,
          healedAt: healedAt ?? now,
          atNext: formatAt(nextAlertTime(f.treeAgeMs, now), now),
          notAsked,
          ranAgain,
          leaf,
          ref,
          agentName,
          coordinator,
        });
        if (!built) continue;
        const mentionCoordinator =
          !!coordinator &&
          !coordinatorOut &&
          (alertOnlyWording || built.mention) &&
          !(f.cause === "A" && f.data.agentId === coordinator.id) &&
          !(f.cause === "R" && f.data.agentId === coordinator.id);
        pending.push({
          rootId: f.rootId,
          rootTitle: root.title,
          rid: issueRef(root),
          fingerprint,
          finding: f,
          cause: f.cause,
          reasonKey: f.reasonKey ?? (tree.isRoutine ? `routine:${f.cause}` : null),
          repeat: f.repeat,
          build: built.build,
          alertOnly: alertOnlyWording,
          mentionCoordinator,
          stalledSince: f.lastProgressAt,
          treeAgeMs: f.treeAgeMs,
          group: built.group,
        });
      }
    }

    await deliverAlerts(companyId, state, pending, now, totals, { effectiveMode, digestSweep, selfRepairAt, alertOnlyCtx, coordinator, renderBase });
    await clearMovingRoots(companyId, state, snapshot, progressByRoot, stalledRoots, now, renderBase);
    updateStallSentinelHealth({ effectiveMode });
  }

  function nextAlertTime(treeAgeMs: number, now: Date) {
    if (treeAgeMs > config.thresholds.oldStallMs) {
      return nextRepeatAt({ firstAt: now, lastSentAt: now, rootId: "", cause: "", repeat: "hourly" }, treeAgeMs, config.thresholds.alertRepeatMs, config.thresholds.oldStallMs)!;
    }
    return new Date(now.getTime() + config.thresholds.alertRepeatMs);
  }

  function buildFindingAlert(
    f: StallFinding,
    v: {
      now: Date;
      healedAt: Date;
      atNext: string;
      /** The wake for this heal was dropped, so nobody was asked. */
      notAsked: boolean;
      /** The requeue started a run, and the task stopped again after it. */
      ranAgain?: boolean;
      leaf: (id: string) => string;
      ref: (id: string) => string;
      agentName: (id: string | null | undefined) => string;
      coordinator: SnapshotAgent | null;
    },
  ): { build: PendingAlert["build"]; mention: boolean; group?: PendingAlert["group"] } | null {
    const base = { rid: v.ref(f.rootId), age: formatAge(f.treeAgeMs), leaf: v.leaf(f.issueId) };
    const atHealed = formatAt(v.healedAt, v.now);
    // The heal's wake never reached the agent: say plainly that the cause is unresolved
    // instead of claiming the agent was woken and has not picked it up.
    if (v.notAsked && f.heal && f.cause !== "P" && f.cause !== "R") {
      return { build: templates.T12({ ...base, atNext: v.atNext }), mention: true };
    }
    switch (f.cause) {
      case "P": {
        if (f.data.lockReason === "codex_agent") {
          return { build: templates.T2L({ ...base, agent: v.agentName(f.data.agentId) }), mention: true };
        }
        if (!f.data.resetsAt || !f.data.provider) return null;
        const restart = new Date(f.data.resetsAt.getTime() + config.thresholds.providerRestartDelayMs);
        const check = new Date(f.data.resetsAt.getTime() + config.thresholds.providerRestartAlertGraceMs);
        const provider = providerDisplayName(f.data.provider);
        return {
          build: templates.T2({
            ...base,
            provider,
            atReset: formatAt(f.data.resetsAt, v.now),
            atRestart: formatAt(restart, v.now),
            byCheck: formatTime(check, v.now),
          }),
          mention: false,
          group: {
            reason: `waiting for ${provider} usage, which comes back ${formatAt(f.data.resetsAt, v.now)}`,
            did: `set them to restart ${formatAt(restart, v.now)}`,
            next: `nothing needed from you. I will tell you again ${formatAt(check, v.now)}.`,
            action: `set them to restart ${formatAt(restart, v.now)}`,
          },
        };
      }
      case "R":
        return {
          build: templates.T5({ ...base, ranFor: formatAge(f.data.ranForMs ?? 0), atHealed, atNext: v.atNext }),
          mention: true,
        };
      case "Q": {
        const busyOn = f.data.busyIssueId ? v.ref(f.data.busyIssueId) : "another task";
        const since = f.data.busySince ? formatTime(f.data.busySince, v.now) : "earlier";
        const agent = v.agentName(f.data.agentId);
        return {
          build: templates.T3({ ...base, agent, busyOn, since, atCheck: v.atNext }),
          mention: true,
          group: {
            reason: `queued for ${agent}, who has been busy on ${busyOn} since ${since}`,
            did: "nothing, as moving work between agents is not safe",
            next: `Jarvis has been asked to move them or wait. I will check again ${v.atNext}.`,
            action: null,
          },
        };
      }
      case "Q2":
      case "L":
        return { build: templates.T4({ ...base, atHealed, atNext: v.atNext, ranAgain: v.ranAgain }), mention: true };
      case "A": {
        if (v.coordinator && f.data.agentId === v.coordinator.id && f.data.agentState === "paused") {
          return { build: templates.T10b({ ...base, atNext: v.atNext }), mention: false };
        }
        const agent = v.agentName(f.data.agentId);
        const state = f.data.agentState ?? "paused";
        return {
          build: templates.T10({ ...base, agent, state, atNext: v.atNext }),
          mention: true,
          group: {
            reason: `assigned to ${agent}, which is ${state}`,
            did: "nothing, because I do not restart agents",
            next: `Jarvis has been asked to move the steps. I will tell you again ${v.atNext}.`,
            action: null,
          },
        };
      }
      case "C":
        if (!f.heal) return { build: templates.T12({ ...base, atNext: v.atNext }), mention: true };
        return {
          build: templates.T8({
            ...base,
            blocker: v.ref(f.data.blockerId!),
            agent: v.agentName(f.data.agentId),
            atHealed,
            atNext: v.atNext,
          }),
          mention: true,
        };
      case "B":
        if (!f.heal) return { build: templates.T7n({ ...base, atNext: v.atNext }), mention: true };
        return { build: templates.T7({ ...base, agent: v.agentName(f.data.agentId), atHealed, atNext: v.atNext }), mention: false };
      case "K": {
        const child = f.data.childId ? v.leaf(f.data.childId) : "a step";
        return {
          build: templates.T9({
            ...base,
            step: child,
            atFinished: formatAt(f.data.childFinishedAt ?? v.now, v.now),
            agent: v.agentName(f.data.agentId),
            atHealed,
            atNext: v.atNext,
          }),
          mention: true,
        };
      }
      case "D": {
        const [first, second] = f.data.duplicateIds ?? [f.issueId, f.issueId];
        return {
          build: templates.T6({ rid: base.rid, step: f.data.stepId ?? "?", first: v.ref(first), second: v.ref(second) }),
          mention: true,
        };
      }
      case "U":
        return { build: templates.T12({ ...base, atNext: v.atNext }), mention: true };
      default:
        return null;
    }
  }

  async function deliverAlerts(
    companyId: string,
    state: CompanyState,
    pending: PendingAlert[],
    now: Date,
    totals: SweepResult,
    ctx: {
      effectiveMode: StallSentinelMode;
      digestSweep: boolean;
      selfRepairAt: Date | null;
      alertOnlyCtx: RenderContext;
      coordinator: SnapshotAgent | null;
      renderBase: RenderContext;
    },
  ) {
    const mem = state.memory;
    // While the alarm only reports, its texts must not claim a wake or a fix that did not happen.
    const textCtx = ctx.effectiveMode === "on" ? ctx.renderBase : ctx.alertOnlyCtx;
    // One message per root per 15 minutes: keep the first alert per root this sweep.
    const accepted: PendingAlert[] = [];
    const rootsThisSweep = new Set<string>();
    for (const alert of pending) {
      if (rootsThisSweep.has(alert.rootId)) continue;
      if (!rootGapOk(mem, alert.rootId, now, config.thresholds.perRootMessageGapMs)) continue;
      rootsThisSweep.add(alert.rootId);
      accepted.push(alert);
    }

    // Start-up digest: trees stuck for over a day before the first sweep go in one message.
    const digest = ctx.digestSweep ? accepted.filter((a) => a.treeAgeMs > config.thresholds.oldStallMs) : [];
    const individual = accepted.filter((a) => !digest.includes(a));
    if (ctx.digestSweep) {
      const text = renderAlert(
        templates.T15({
          count: digest.length,
          rids: digest.map((a) => a.rid),
          selfRepairStarts: ctx.selfRepairAt ? formatTime(ctx.selfRepairAt, now) : "later",
        }),
        "",
        ctx.renderBase,
        config.groupListLimit,
      );
      await sendTelegram(companyId, state, text, now, true);
    }

    // Grouping: the same reason key in one sweep becomes one Telegram message.
    const groups = new Map<string, PendingAlert[]>();
    for (const alert of individual) {
      if (!alert.reasonKey) continue;
      groups.set(alert.reasonKey, [...(groups.get(alert.reasonKey) ?? []), alert]);
    }
    const grouped = new Set<PendingAlert>();
    const groupTexts: Array<{ alerts: PendingAlert[]; text: string }> = [];
    for (const alerts of groups.values()) {
      if (alerts.length < 2) continue;
      const first = alerts[0]!;
      const group = first.group ?? {
        reason: "the same cause",
        did: "nothing",
        next: "Jarvis has been asked to look.",
        action: null,
      };
      const text = renderAlert(
        templates.T14({
          count: alerts.length,
          reason: group.reason,
          rids: alerts.map((a) => a.rid),
          did: group.did,
          next: group.next,
          action: group.action,
        }),
        "",
        textCtx,
        config.groupListLimit,
      );
      groupTexts.push({ alerts, text });
      for (const alert of alerts) grouped.add(alert);
    }

    // Messages over last hour's cap go first, as one "and N more" message.
    if (mem.capOverflow > 0 && telegramAllowed(mem, now, config.companyTelegramCapPerHour)) {
      const overflow = mem.capOverflow;
      mem.capOverflow = 0;
      await sendTelegram(companyId, state, renderAlert(templates.TCap({ count: overflow }), "", ctx.renderBase), now);
    }
    const sentFor = new Map<PendingAlert, { sent: boolean; reason?: string }>();
    for (const { alerts, text } of groupTexts) {
      const result = await sendTelegram(companyId, state, text, now);
      for (const alert of alerts) sentFor.set(alert, result);
    }
    for (const alert of individual) {
      if (grouped.has(alert)) continue;
      const text = renderAlert(alert.build, alert.rootTitle, textCtx, config.groupListLimit);
      sentFor.set(alert, await sendTelegram(companyId, state, text, now));
    }

    for (const alert of accepted) {
      const inDigest = digest.includes(alert);
      const result = inDigest ? { sent: true } : sentFor.get(alert) ?? { sent: false, reason: "not_sent" };
      const text = renderAlert(alert.build, alert.rootTitle, textCtx, config.groupListLimit);
      const mention = alert.mentionCoordinator && ctx.coordinator ? ` ${coordinatorMention(ctx.coordinator)}` : "";
      await deps.actions.comment(alert.rootId, `${text}${mention}`);
      // Alert-only mode creates no wake request at all (design section f).
      if (alert.mentionCoordinator && ctx.coordinator && ctx.effectiveMode === "on") {
        await deps.actions.wake(ctx.coordinator.id, {
          issueId: alert.rootId,
          reason: "stall_sentinel_reroute",
          idempotencyKey: `stall-sentinel:reroute:${alert.fingerprint.slice(0, 24)}:${now.toISOString()}`,
          payload: { stallCause: alert.cause, frontierIssueId: alert.finding?.issueId ?? null, message: text },
        });
      }
      await deps.actions.activity({
        companyId,
        action: SENTINEL_ACTIONS.alerted,
        entityType: "issue",
        entityId: alert.rootId,
        details: {
          fingerprint: alert.fingerprint,
          cause: alert.cause,
          reasonKey: alert.reasonKey,
          rootIssueId: alert.rootId,
          issueId: alert.finding?.issueId ?? null,
          repeat: alert.repeat,
          sent: result.sent,
          digest: inDigest,
          alertOnly: alert.alertOnly,
          stalledSince: alert.stalledSince?.toISOString() ?? null,
          ...(result.reason ? { deliveryError: result.reason } : {}),
        },
      });
      const prev = mem.alerts.get(alert.fingerprint);
      mem.alerts.set(alert.fingerprint, {
        firstAt: prev?.firstAt ?? now,
        lastSentAt: now,
        rootId: alert.rootId,
        cause: alert.cause,
        repeat: alert.repeat,
      });
      mem.rootLastMessageAt.set(alert.rootId, now);
      mem.alertOnlyStalls.add(alert.fingerprint);
      const open = mem.openRoots.get(alert.rootId);
      if (!open) {
        mem.openRoots.set(alert.rootId, { firstAlertAt: now, stalledSince: alert.stalledSince, telegramSent: result.sent });
      } else if (result.sent) {
        open.telegramSent = true;
      }
      totals.alerts += 1;
      if (result.sent && !inDigest) totals.telegrams += 1;
    }
  }

  async function clearMovingRoots(
    companyId: string,
    state: CompanyState,
    snapshot: CompanySnapshot,
    progressByRoot: Map<string, { at: Date | null; issueId: string | null }>,
    stalledRoots: Set<string>,
    now: Date,
    renderBase: RenderContext,
  ) {
    const mem = state.memory;
    const moving: Array<{ rootId: string; text: string; rid: string; sent: boolean }> = [];
    for (const [rootId, open] of mem.openRoots) {
      if (rootId === companyId) continue;
      const progress = progressByRoot.get(rootId);
      const root = snapshot.issues.get(rootId);
      if (!progress) {
        // No longer watched (closed, hidden, or no agent work left): forget it quietly.
        moving.push({ rootId, text: "", rid: "", sent: false });
        continue;
      }
      if (stalledRoots.has(rootId) || !progress.at || progress.at <= open.firstAlertAt) continue;
      const at = progress.at;
      const stalledFor = open.stalledSince ? at.getTime() - open.stalledSince.getTime() : at.getTime() - open.firstAlertAt.getTime();
      const leafIssue = progress.issueId ? snapshot.issues.get(progress.issueId) : root;
      const text = root
        ? renderAlert(
            templates.T13({
              rid: issueRef(root),
              leaf: leafIssue ? leafLabel(leafIssue) : issueRef(root),
              atProgress: formatAt(at, now),
              stalledFor: formatAge(stalledFor),
            }),
            root.title,
            renderBase,
          )
        : "";
      moving.push({ rootId, text, rid: root ? issueRef(root) : rootId.slice(0, 8), sent: open.telegramSent });
    }
    if (moving.length === 0) return;
    const toTell = moving.filter((m) => m.sent && m.text);
    if (toTell.length === 1) {
      await sendTelegram(companyId, state, toTell[0]!.text, now);
    } else if (toTell.length > 1) {
      await sendTelegram(
        companyId,
        state,
        renderAlert(templates.T13g({ rids: toTell.map((m) => m.rid) }), "", renderBase, config.groupListLimit),
        now,
      );
    }
    for (const m of moving) {
      if (m.text) await deps.actions.comment(m.rootId, m.text);
      if (!m.text && !snapshot.issues.has(m.rootId)) {
        mem.openRoots.delete(m.rootId);
        continue;
      }
      await deps.actions.activity({
        companyId,
        action: SENTINEL_ACTIONS.cleared,
        entityType: "issue",
        entityId: m.rootId,
        details: { rootIssueId: m.rootId, told: m.sent },
      });
      mem.openRoots.delete(m.rootId);
      for (const [fingerprint, record] of mem.alerts) {
        if (record.rootId === m.rootId) mem.alerts.delete(fingerprint);
      }
    }
  }

  function healComment(
    snapshot: CompanySnapshot,
    f: StallFinding,
    now: Date,
    wouldHave: boolean,
    alertOnlyCtx?: RenderContext,
    wake: WakeState = "queued",
  ): string {
    const row = snapshot.issues.get(f.issueId);
    const leaf = row ? leafLabel(row) : f.issueId.slice(0, 8);
    const agent = (id: string | null | undefined) => (id ? snapshot.agents.get(id)?.name ?? "its agent" : "its agent");
    const heal = f.heal!;
    let did: string;
    switch (heal.kind) {
      case "requeue":
        did = `nothing was working on ${leaf}, so I restarted it`;
        break;
      case "restart_after_reset":
        did = `${leaf} is waiting for ${providerDisplayName(f.data.provider ?? "anthropic")} usage, so I set it to restart ${formatAt(heal.wakeAt, now)}`;
        break;
      case "rewrite_to_claude":
        did = `moved ${leaf} from OpenAI to Claude${heal.rewrite.toModel ? ` (${heal.rewrite.toModel})` : ""}, because OpenAI is not in use`;
        break;
      case "cancel_stuck_run":
        did = `${leaf} ran for ${formatAge(f.data.ranForMs ?? 0)} without saving any work, so I stopped and restarted it`;
        break;
      case "cancel_duplicate": {
        const kept = snapshot.issues.get(heal.keptIssueId);
        did = `cancelled ${leaf}, an empty copy of step ${f.data.stepId ?? ""}, and kept ${kept ? issueRef(kept) : heal.keptIssueId.slice(0, 8)}`;
        break;
      }
      case "wake":
        did =
          f.cause === "B"
            ? `${leaf} is blocked but names no blocker, so I asked ${agent(heal.agentId)} to name it or carry on`
            : f.cause === "C"
              ? `${leaf} waits for a cancelled task, so I asked ${agent(heal.agentId)} to replace or remove that blocker`
              : `a step under ${leaf} finished, so I woke ${agent(heal.agentId)} to pick it up`;
        break;
    }
    if (!wouldHave && wake === "pending") {
      did =
        heal.kind === "requeue"
          ? `nothing was working on ${leaf}, but a restart was already waiting, so I queued no second one`
          : `${did}; a wake was already waiting, so I queued no second one`;
    }
    if (!wouldHave && wake === "dropped") {
      did = `I could not wake the agent for ${leaf}: the wake was not accepted (the task changed or is on hold), so nothing was restarted`;
    }
    if (!wouldHave) return `Stall alarm: ${did}. Nothing needed from you.`;
    const until = alertOnlyCtx?.alertOnly?.selfRepairFrom;
    return `Stall alarm (self-repair is off${until ? ` until ${until}` : ""}): I would have done this: ${did}.`;
  }

  type WakeState = "queued" | "pending" | "dropped";
  const wakeState = (result: { queued: boolean; reason?: string }): WakeState =>
    result.queued ? "queued" : result.reason === "already_pending" ? "pending" : "dropped";

  async function applyHeal(companyId: string, snapshot: CompanySnapshot, f: StallFinding, rootId: string, hk: string, now: Date) {
    const heal = f.heal!;
    const target = snapshot.issues.get(heal.issueId);
    const statusVersion = target?.statusVersion ?? 0;
    const details: Record<string, unknown> = {
      cause: f.cause,
      healKey: hk,
      action: heal.kind,
      issueId: heal.issueId,
      rootIssueId: rootId,
      subject: f.data.childId ?? null,
    };
    let wake: WakeState = "queued";
    switch (heal.kind) {
      case "requeue":
        wake = wakeState(
          await deps.actions.wake(heal.agentId, {
            issueId: heal.issueId,
            reason: heal.reason,
            idempotencyKey: `stall-sentinel:${f.cause}:${heal.issueId}:${statusVersion}`,
            guard: target ? { statuses: [target.status], assigneeAgentId: heal.agentId, statusVersion } : undefined,
          }),
        );
        break;
      case "restart_after_reset":
        details.wakeAt = heal.wakeAt.toISOString();
        break;
      case "rewrite_to_claude":
        await deps.actions.setIssueOverrides(heal.issueId, heal.rewrite.overrides);
        for (const runId of heal.cancelRunIds) await deps.actions.cancelRun(runId, "stall_sentinel: moved to Claude");
        if (heal.wake) {
          await deps.actions.wake(heal.agentId, {
            issueId: heal.issueId,
            reason: "stall_sentinel_provider_rewrite",
            idempotencyKey: `stall-sentinel:P:${heal.issueId}:rewrite:${statusVersion}`,
          });
        }
        details.previousOverrides = heal.previousOverrides ?? null;
        details.toModel = heal.rewrite.toModel;
        break;
      case "cancel_stuck_run":
        await deps.actions.cancelRun(heal.runId, "stall_sentinel: stuck run");
        wake = wakeState(
          await deps.actions.wake(heal.agentId, {
            issueId: heal.issueId,
            reason: "stall_sentinel_resume",
            idempotencyKey: `stall-sentinel:R:${heal.issueId}:${heal.runId}`,
          }),
        );
        details.runId = heal.runId;
        break;
      case "cancel_duplicate": {
        const kept = snapshot.issues.get(heal.keptIssueId);
        await deps.actions.cancelIssue(heal.issueId);
        await deps.actions.comment(
          heal.issueId,
          `Stall alarm: cancelled as an empty duplicate of ${kept ? issueRef(kept) : heal.keptIssueId}. Nothing needed from you.`,
        );
        details.keptIssueId = heal.keptIssueId;
        break;
      }
      case "wake":
        wake = wakeState(
          await deps.actions.wake(heal.agentId, {
            issueId: heal.issueId,
            reason: heal.reason,
            idempotencyKey: `stall-sentinel:${f.cause}:${heal.issueId}:${statusVersion}${f.data.childId ? `:${f.data.childId}` : ""}`,
            payload: { ...heal.payload, ...(heal.message ? { message: heal.message } : {}) },
            guard: target?.assigneeAgentId === heal.agentId
              ? { statuses: [target.status], assigneeAgentId: heal.agentId, statusVersion }
              : undefined,
          }),
        );
        break;
    }
    // A dropped wake means nobody was asked: the memory says so, and the later alert says "unresolved",
    // never "woke X, who has not picked it up".
    if (wake !== "queued") details.wake = wake;
    if (wake === "dropped") details.asked = false;
    await deps.actions.comment(rootId, healComment(snapshot, f, now, false, undefined, wake));
    await deps.actions.activity({
      companyId,
      action: SENTINEL_ACTIONS.healed,
      entityType: "issue",
      entityId: rootId,
      details,
    });
    states.get(companyId)!.memory.heals.set(hk, {
      at: now,
      kind: heal.kind,
      applied: true,
      ...(heal.kind === "restart_after_reset" ? { wakeAt: heal.wakeAt } : {}),
      ...(wake === "dropped" ? { asked: false } : {}),
    });
  }

  async function fireScheduledRestart(companyId: string, snapshot: CompanySnapshot, f: StallFinding, wakeAt: Date, rootId: string) {
    const heal = f.heal;
    if (!heal || heal.kind !== "restart_after_reset") return;
    const key = `stall-sentinel:P:${heal.issueId}:${wakeAt.toISOString()}`;
    if (snapshot.wakes.some((wake) => wake.idempotencyKey === key)) return;
    const target = snapshot.issues.get(heal.issueId);
    await deps.actions.wake(heal.agentId, {
      issueId: heal.issueId,
      reason: "stall_sentinel_provider_reset",
      idempotencyKey: key,
      guard: target ? { statuses: [target.status], assigneeAgentId: heal.agentId, statusVersion: target.statusVersion } : undefined,
    });
    // Recorded in the snapshot too, so the same sweep never queues it twice.
    snapshot.wakes.push({
      id: key,
      agentId: heal.agentId,
      issueId: heal.issueId,
      status: "queued",
      reason: "stall_sentinel_provider_reset",
      idempotencyKey: key,
      requestedAt: wakeAt,
    });
    await deps.actions.activity({
      companyId,
      action: SENTINEL_ACTIONS.healed,
      entityType: "issue",
      entityId: rootId,
      details: { cause: "P", action: "restart_wake", issueId: heal.issueId, rootIssueId: rootId, subject: "restart_wake" },
    });
  }

  async function recordWouldHeal(
    companyId: string,
    snapshot: CompanySnapshot,
    f: StallFinding,
    rootId: string,
    hk: string,
    now: Date,
    alertOnlyCtx: RenderContext,
  ) {
    const heal = f.heal!;
    // Silent heals get a root comment; the others are reported by their alert.
    if (f.silent || heal.kind === "cancel_duplicate") {
      await deps.actions.comment(rootId, healComment(snapshot, f, now, true, alertOnlyCtx));
    }
    await deps.actions.activity({
      companyId,
      action: SENTINEL_ACTIONS.wouldHeal,
      entityType: "issue",
      entityId: rootId,
      details: { cause: f.cause, healKey: hk, action: heal.kind, issueId: heal.issueId, rootIssueId: rootId, subject: f.data.childId ?? null },
    });
    const mem = states.get(companyId)!.memory;
    mem.heals.set(hk, { at: now, kind: heal.kind, applied: false });
    mem.alertOnlyFixes += 1;
  }

  /** `aborted` is set when the 60 second limit passes: the late sweep stops and writes nothing more. */
  async function sweep(run: { aborted: boolean } = { aborted: false }): Promise<SweepResult> {
    const now = clock();
    const totals: SweepResult = { skipped: false, companies: 0, heals: 0, wouldHeals: 0, alerts: 0, telegrams: 0 };
    if (config.mode === "off") {
      updateStallSentinelHealth({ mode: "off", effectiveMode: "off" });
      return { ...totals, skipped: true };
    }
    let gapFrom: Date | null = null;
    if (!gapChecked) {
      gapChecked = true;
      const last = deps.persistence.readLastSweepAt();
      if (last && now.getTime() - last.getTime() > config.freshnessMs) gapFrom = last;
    }
    const suppressed = (await deps.resolveSchedulingSuppression().catch(() => ({ suppressed: false }))).suppressed;
    const companyIds = await deps.store.listCompanyIds();
    knownCompanyIds = companyIds;
    for (const companyId of companyIds) {
      if (run.aborted) return totals;
      await sweepCompany(companyId, now, totals, { gapFrom, suppressed, run });
      totals.companies += 1;
    }
    if (run.aborted) return totals;
    deps.persistence.writeLastSweepAt(now);
    let open = 0;
    for (const state of states.values()) open += state.memory.openRoots.size;
    updateStallSentinelHealth({
      mode: config.mode,
      lastSweepAt: now.toISOString(),
      lastSweepOk: true,
      consecutiveFailures: 0,
      openStalls: open,
      lastAlertAt,
      lastDeliveryError,
    });
    return totals;
  }

  /**
   * Called on every scheduler tick (30 s). Runs a sweep when none is running
   * and the interval has passed since the last one started. Each sweep has a
   * 60 s limit; three failures in a row send one plain message.
   */
  async function tick(): Promise<SweepResult | null> {
    const now = clock();
    if (config.mode === "off") {
      updateStallSentinelHealth({ mode: "off", effectiveMode: "off" });
      return null;
    }
    if (sweeping) return null;
    if (lastSweepStartedAt && now.getTime() - lastSweepStartedAt.getTime() < config.sweepIntervalMs) return null;
    sweeping = true;
    lastSweepStartedAt = now;
    const run = { aborted: false };
    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;
    const sweepPromise = sweep(run);
    try {
      const result = await Promise.race([
        sweepPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            run.aborted = true;
            reject(new Error("stall sentinel sweep timed out"));
          }, config.sweepTimeoutMs);
          timer.unref?.();
        }),
      ]);
      consecutiveFailures = 0;
      for (const state of states.values()) state.failureAlertSent = false;
      updateStallSentinelHealth({ lastSweepDurationMs: clock().getTime() - now.getTime() });
      return result;
    } catch (err) {
      consecutiveFailures += 1;
      logger.error({ err, consecutiveFailures }, "stall sentinel sweep failed");
      updateStallSentinelHealth({
        lastSweepAt: now.toISOString(),
        lastSweepOk: false,
        consecutiveFailures,
        lastSweepDurationMs: clock().getTime() - now.getTime(),
      });
      if (consecutiveFailures >= config.failureAlertAfter) await sendFailureNotice(now).catch(() => undefined);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        // The old sweep is still running: no second sweep may start until it has stopped.
        const release = () => {
          sweeping = false;
        };
        sweepPromise.then(release, release);
      } else {
        sweeping = false;
      }
    }
  }

  async function sendFailureNotice(now: Date) {
    const companyIds = await deps.store.listCompanyIds().catch(() => knownCompanyIds);
    for (const companyId of companyIds) {
      const state = states.get(companyId) ?? { memory: emptyMemory(), rollout: { startedAt: null, selfRepairOnAt: null }, holdSince: null, failureAlertSent: false };
      states.set(companyId, state);
      if (state.failureAlertSent) continue;
      state.failureAlertSent = true;
      await sendTelegram(companyId, state, renderAlert(templates.TF(), "", { alertOnly: null }), now, true);
    }
  }

  return { config, sweep, tick };
}

export type StallSentinel = ReturnType<typeof createStallSentinel>;

/** Default store: the read-only loaders against the server database. */
type SilencePort = { buildRunOutputSilence: (run: SilenceRunFields, now: Date) => Promise<{ silenceAgeMs: number | null }> };

export function createStallSentinelStore(db: Db, heartbeat: SilencePort | null): StallSentinelStore {
  const recoveryActions = issueRecoveryActionService(db);
  return {
    async listCompanyIds() {
      const rows = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, "active"));
      return rows.map((row) => row.id);
    },
    loadSnapshot(companyId, now, lookbackMs) {
      return loadCompanySnapshot(
        {
          db,
          measureSilence: async (run, at) =>
            heartbeat ? (await heartbeat.buildRunOutputSilence(run, at)).silenceAgeMs : null,
          listActiveRecovery: async (id, issueIds) => new Set((await recoveryActions.listActiveForIssues(id, issueIds)).keys()),
        },
        companyId,
        now,
        lookbackMs,
      );
    },
    loadMemoryRows: (companyId, since) => loadMemoryRows(db, companyId, since),
    loadRollout: (companyId) => loadRolloutState(db, companyId),
  };
}

export function createFileSweepPersistence(filePath = path.join(resolvePaperclipInstanceRoot(), "stall-sentinel-state.json")): StallSentinelPersistence {
  return {
    readLastSweepAt() {
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { lastSweepAt?: string };
        const at = parsed.lastSweepAt ? new Date(parsed.lastSweepAt) : null;
        return at && !Number.isNaN(at.getTime()) ? at : null;
      } catch {
        return null;
      }
    },
    writeLastSweepAt(at) {
      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp`;
        writeFileSync(tmp, JSON.stringify({ lastSweepAt: at.toISOString() }));
        renameSync(tmp, filePath);
      } catch (err) {
        logger.warn({ err }, "stall sentinel could not persist its last sweep time");
      }
    },
  };
}

/** Server wiring: the real store, actions, quota providers and persistence. */
export function createServerStallSentinel(input: {
  db: Db;
  heartbeat:
    | (HeartbeatWakePort & {
        resolveSchedulingSuppression: () => Promise<{ suppressed: boolean }>;
      } & SilencePort)
    | null;
  send: ((companyId: string, text: string) => Promise<{ sent: boolean; reason?: string }>) | null;
}) {
  const vault = createQuotaVaultCredentialResolver(input.db);
  return createStallSentinel({
    store: createStallSentinelStore(input.db, input.heartbeat),
    actions: createStallSentinelActions({ db: input.db, heartbeat: input.heartbeat, send: input.send }),
    fetchQuota: async (companyId) => summarizeQuotaWindows(await fetchAllQuotaWindows(companyId, vault)),
    resolveSchedulingSuppression: input.heartbeat
      ? () => input.heartbeat!.resolveSchedulingSuppression()
      : async () => ({ suppressed: false }),
    persistence: createFileSweepPersistence(),
  });
}

export { getStallSentinelHealth, getStallSentinelHealthDetails } from "./health-state.js";
export { readStallSentinelConfig } from "./config.js";
