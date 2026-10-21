import { describe, expect, it } from "vitest";
import {
  allowsDependencyBlockedWake,
  allowsIssueInteractionWake,
  deriveCommentId,
  extractWakeCommentIds,
  isNonAssigneeWorkspaceBusyRetry,
  isResolvedInteractionContinuationWakeContext,
  WORKSPACE_BUSY_RETRY_REASON,
} from "./wake-context.js";

describe("wake context", () => {
  it("requires the subscription-specific non-assignee receipt for a subscription wait", () => {
    expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_busy", {
      aiConnectionBusyDeferredWhileAssignee: false,
    })).toBe(true);
    for (const context of [ {}, { aiConnectionBusyDeferredWhileAssignee: true }, { workspaceBusyDeferredWhileAssignee: false } ]) {
      expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_busy", context)).toBe(false);
    }
    expect(isNonAssigneeWorkspaceBusyRetry("transient_failure", { aiConnectionBusyDeferredWhileAssignee: false })).toBe(false);
  });
  it("recognizes only workspace-busy retries deferred outside assignee-ship", () => {
    expect(isNonAssigneeWorkspaceBusyRetry(WORKSPACE_BUSY_RETRY_REASON, {
      workspaceBusyDeferredWhileAssignee: false,
    })).toBe(true);
    expect(isNonAssigneeWorkspaceBusyRetry(WORKSPACE_BUSY_RETRY_REASON, {
      workspaceBusyDeferredWhileAssignee: true,
    })).toBe(false);
    expect(isNonAssigneeWorkspaceBusyRetry("another_reason", {
      workspaceBusyDeferredWhileAssignee: false,
    })).toBe(false);
  });

  it("keeps ordered, unique, non-empty wake comment ids", () => {
    expect(extractWakeCommentIds({
      wakeCommentIds: ["comment-1", "", null, "comment-2", "comment-1"],
    })).toEqual(["comment-1", "comment-2"]);
    expect(extractWakeCommentIds({ wakeCommentIds: "comment-1" })).toEqual([]);
    expect(extractWakeCommentIds(undefined)).toEqual([]);
  });

  it.each([
    [{ wakeCommentIds: ["batch-1", "batch-2"], wakeCommentId: "wake" }, {}, "batch-2"],
    [{ wakeCommentId: "wake", commentId: "context" }, {}, "wake"],
    [{ commentId: "context" }, { commentId: "payload" }, "context"],
    [{}, { commentId: "payload" }, "payload"],
    [{ wakeCommentId: "  " }, { commentId: "  " }, null],
  ])("derives comment ids by canonical precedence", (context, payload, expected) => {
    expect(deriveCommentId(context, payload)).toBe(expected);
  });

  it("allows interaction wakes only for an allowed reason with a comment id", () => {
    const allowed = new Set(["issue_commented"]);
    expect(allowsIssueInteractionWake({
      wakeReason: "issue_commented",
      wakeCommentId: "comment-1",
    }, allowed)).toBe(true);
    expect(allowsIssueInteractionWake({
      wakeReason: "timer",
      wakeCommentId: "comment-1",
    }, allowed)).toBe(false);
    expect(allowsIssueInteractionWake({ wakeReason: "issue_commented" }, allowed)).toBe(false);
  });

  it("lets a resolved interaction continuation through the dependency gate without a comment id", () => {
    const allowed = new Set(["issue_commented"]);
    expect(allowsDependencyBlockedWake({
      wakeReason: "issue_commented",
      mutation: "interaction",
      interactionId: "interaction-1",
      interactionStatus: "accepted",
      sourceCommentId: null,
    }, allowed)).toBe(true);
    expect(allowsDependencyBlockedWake({
      wakeReason: "issue_commented",
      wakeCommentId: "comment-1",
    }, allowed)).toBe(true);
    expect(allowsDependencyBlockedWake({
      wakeReason: "issue_commented",
      mutation: "interaction",
      interactionId: "interaction-1",
      interactionStatus: "pending",
    }, allowed)).toBe(false);
    expect(allowsDependencyBlockedWake({ wakeReason: "issue_assigned" }, allowed)).toBe(false);
  });

  it.each([
    "stall_sentinel_checkpoint_done",
    "stall_sentinel_cancelled_blocker",
    "stall_sentinel_reroute",
  ])("lets the stall sentinel wake %s through the dependency gate", (wakeReason) => {
    expect(allowsDependencyBlockedWake({ wakeReason, stallSentinelWake: true }, new Set(["issue_commented"]))).toBe(true);
  });

  it.each([
    "stall_sentinel_checkpoint_done",
    "stall_sentinel_cancelled_blocker",
    "stall_sentinel_reroute",
  ])("skips %s on a dependency-blocked issue when the sentinel did not send it", (wakeReason) => {
    expect(allowsDependencyBlockedWake({ wakeReason }, new Set(["issue_commented"]))).toBe(false);
    expect(allowsDependencyBlockedWake({ wakeReason, stallSentinelWake: "true" }, new Set(["issue_commented"]))).toBe(false);
  });

  it.each([
    "stall_sentinel_requeue",
    "stall_sentinel_resume",
    "stall_sentinel_blocked_without_blocker",
    "stall_sentinel_provider_reset",
    "stall_sentinel_provider_rewrite",
    "issue_assigned",
    "issue_blockers_resolved",
    "heartbeat_timer",
    "stall_sentinel_reroute_extra",
  ])("still skips the automatic wake %s on a dependency-blocked issue", (wakeReason) => {
    expect(allowsDependencyBlockedWake({ wakeReason, stallSentinelWake: true }, new Set(["issue_commented"]))).toBe(false);
  });

  it.each(["accepted", "answered", "cancelled", "rejected"])(
    "recognizes %s issue-comment interaction continuations",
    (interactionStatus) => {
      expect(isResolvedInteractionContinuationWakeContext({
        interactionId: "interaction-1",
        interactionStatus,
        mutation: "interaction",
        wakeReason: "issue_commented",
      })).toBe(true);
    },
  );

  it.each(["accepted", "answered", "cancelled", "rejected"])(
    "recognizes %s infrastructure continuations and rejects incomplete contexts",
    (interactionStatus) => {
      const base = { interactionId: "interaction-1", interactionStatus };
      expect(isResolvedInteractionContinuationWakeContext({
        ...base,
        wakeReason: "interaction_continuation_infra_retry",
      })).toBe(true);
      expect(isResolvedInteractionContinuationWakeContext({
        ...base,
        retryReason: "interaction_continuation_infra_retry",
      })).toBe(true);
      expect(isResolvedInteractionContinuationWakeContext({ ...base, interactionStatus: "pending" })).toBe(false);
      expect(isResolvedInteractionContinuationWakeContext({ interactionStatus })).toBe(false);
      expect(isResolvedInteractionContinuationWakeContext(null)).toBe(false);
    },
  );
});
