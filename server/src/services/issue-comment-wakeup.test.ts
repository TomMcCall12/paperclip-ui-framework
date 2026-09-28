import { describe, expect, it } from "vitest";
import {
  isIssueCommentWakeIdempotencyKey,
  issueCommentWakeIdempotencyKey,
  shouldWakeAssigneeForIssueComment,
} from "./issue-comment-wakeup.js";

describe("issue comment wake idempotency key", () => {
  it("binds one wake to the persisted comment identity", () => {
    const key = issueCommentWakeIdempotencyKey("11111111-1111-4111-8111-111111111111");
    expect(key).toBe("issue-comment:11111111-1111-4111-8111-111111111111");
    expect(isIssueCommentWakeIdempotencyKey(key)).toBe(true);
  });

  it("does not treat other durable wake receipts as comment deliveries", () => {
    for (const key of [null, undefined, "", "chat-inbound:abc", "queued-comment-delivery:abc", "remote-stop-comment:a:b", "issue-comment:"]) {
      expect(isIssueCommentWakeIdempotencyKey(key)).toBe(false);
    }
  });
});

describe("shouldWakeAssigneeForIssueComment", () => {
  it("suppresses explicit resume from the run that currently owns the issue", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-current",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("preserves explicit resume from a completed prior run", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(true);
  });

  it("keeps ordinary self-comments inert", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: false,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {},
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("does not wake a closed issue unless the comment reopened it", () => {
    const base = {
      selfComment: false,
      resumeRequested: false,
      issueAtCommentStart: {},
      currentStatus: "done",
    };
    expect(
      shouldWakeAssigneeForIssueComment({ ...base, reopened: false }),
    ).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...base, reopened: true })).toBe(
      true,
    );
  });
});
