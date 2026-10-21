import type { Db } from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import { issueService } from "../issues.js";
import { STALL_SENTINEL_ACTOR_ID } from "./config.js";

/**
 * Side effects of the stall sentinel. Everything that changes state goes
 * through here so tests can prove what alert-only mode does not touch.
 *
 * No model, no agent adapter: wakes go through the heartbeat queue, comments
 * are system comments (the comment service does not wake anyone for them), and
 * Telegram goes through the board notice path.
 */

export interface SentinelWakeOptions {
  issueId: string;
  reason: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  /** Drop the wake if the task changed in the meantime. */
  guard?: { statuses: string[]; assigneeAgentId: string; statusVersion?: number };
}

export interface StallSentinelActions {
  /** Mutating: queue a wake. */
  wake(agentId: string, opts: SentinelWakeOptions): Promise<{ queued: boolean }>;
  /** Mutating: cancel a run. */
  cancelRun(runId: string, reason: string): Promise<void>;
  /** Mutating: replace an issue's task-level adapter overrides (validated like the API). */
  setIssueOverrides(issueId: string, overrides: Record<string, unknown> | null): Promise<void>;
  /** Mutating: cancel an exact duplicate issue. */
  cancelIssue(issueId: string): Promise<void>;
  /** Allowed in alert-only mode: system comment, no wake. */
  comment(issueId: string, body: string): Promise<void>;
  /** Allowed in alert-only mode: one activity row. */
  activity(input: {
    companyId: string;
    action: string;
    entityType: "issue" | "company";
    entityId: string;
    details: Record<string, unknown>;
  }): Promise<void>;
  /** Allowed in alert-only mode: one Telegram message to the board. */
  telegram(companyId: string, text: string): Promise<{ sent: boolean; reason?: string }>;
}

export interface HeartbeatWakePort {
  wakeup(
    agentId: string,
    opts: {
      source?: "automation";
      triggerDetail?: "system";
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      idempotencyKey?: string | null;
      requestedByActorType?: "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
      issueStateGuard?: { statuses: string[]; assigneeAgentId: string; statusVersion?: number };
    },
  ): Promise<unknown>;
  cancelRun(runId: string, reason?: string): Promise<unknown>;
}

export function createStallSentinelActions(input: {
  db: Db;
  heartbeat: HeartbeatWakePort | null;
  send: ((companyId: string, text: string) => Promise<{ sent: boolean; reason?: string }>) | null;
}): StallSentinelActions {
  const issues = issueService(input.db);
  return {
    async wake(agentId, opts) {
      if (!input.heartbeat) return { queued: false };
      const result = await input.heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: opts.reason,
        payload: { ...(opts.payload ?? {}), issueId: opts.issueId },
        idempotencyKey: opts.idempotencyKey,
        requestedByActorType: "system",
        requestedByActorId: STALL_SENTINEL_ACTOR_ID,
        contextSnapshot: { issueId: opts.issueId, wakeReason: opts.reason },
        ...(opts.guard ? { issueStateGuard: opts.guard } : {}),
      });
      return { queued: result != null };
    },
    async cancelRun(runId, reason) {
      if (!input.heartbeat) return;
      await input.heartbeat.cancelRun(runId, reason);
    },
    async setIssueOverrides(issueId, overrides) {
      await issues.update(issueId, { assigneeAdapterOverrides: overrides });
    },
    async cancelIssue(issueId) {
      await issues.update(issueId, { status: "cancelled" });
    },
    async comment(issueId, body) {
      await issues.addComment(issueId, body, {}, { authorType: "system" });
    },
    async activity(row) {
      await logActivity(input.db, {
        companyId: row.companyId,
        actorType: "system",
        actorId: STALL_SENTINEL_ACTOR_ID,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        details: row.details,
      });
    },
    async telegram(companyId, text) {
      if (!input.send) return { sent: false, reason: "telegram_not_configured" };
      try {
        return await input.send(companyId, text);
      } catch {
        // Never surface the provider error text: a Bot API URL carries the token.
        return { sent: false, reason: "send_failed" };
      }
    },
  };
}
