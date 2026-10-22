import { describe, expect, it } from "vitest";
import {
  IDLE_TODO_TASK_IDLE_THRESHOLD_MS,
  IDLE_TODO_TASK_WAKE_COOLDOWN_MS,
  IDLE_TODO_TASK_WAKE_REASON,
  buildIdleTodoTaskWakeIdempotencyKey,
  isIdleTodoTaskStale,
  isIdleTodoTaskWakeCooldownActive,
  isIssueIdleTodoTaskCandidate,
  shouldWakeIdleTodoTask,
} from "./idle-todo-task-wakeups.js";

const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = new Date("2026-04-01T12:00:00.000Z");

function minutesBefore(reference: Date, minutes: number) {
  return new Date(reference.getTime() - minutes * 60 * 1000);
}

describe("isIssueIdleTodoTaskCandidate", () => {
  it("is true only for a todo issue with an assigned agent", () => {
    expect(
      isIssueIdleTodoTaskCandidate({ status: "todo", assigneeAgentId: agentId }),
    ).toBe(true);
  });

  it("is false for a non-todo status", () => {
    expect(
      isIssueIdleTodoTaskCandidate({ status: "in_progress", assigneeAgentId: agentId }),
    ).toBe(false);
  });

  it("is false with no assignee", () => {
    expect(
      isIssueIdleTodoTaskCandidate({ status: "todo", assigneeAgentId: null }),
    ).toBe(false);
  });
});

describe("isIdleTodoTaskStale", () => {
  it("is false just under the idle threshold", () => {
    const lastActivityAt = minutesBefore(now, 9);
    expect(isIdleTodoTaskStale({ lastActivityAt, now })).toBe(false);
  });

  it("is true once the idle threshold has elapsed", () => {
    const lastActivityAt = minutesBefore(now, 10);
    expect(isIdleTodoTaskStale({ lastActivityAt, now })).toBe(true);
  });

  it("honors a custom threshold", () => {
    const lastActivityAt = minutesBefore(now, 3);
    expect(
      isIdleTodoTaskStale({ lastActivityAt, now, idleThresholdMs: 2 * 60 * 1000 }),
    ).toBe(true);
  });
});

describe("isIdleTodoTaskWakeCooldownActive", () => {
  it("is false when there is no prior wake", () => {
    expect(isIdleTodoTaskWakeCooldownActive({ lastWakeAt: null, now })).toBe(false);
  });

  it("is true inside the cooldown window", () => {
    const lastWakeAt = minutesBefore(now, 30);
    expect(isIdleTodoTaskWakeCooldownActive({ lastWakeAt, now })).toBe(true);
  });

  it("is false once the cooldown window has elapsed", () => {
    const lastWakeAt = minutesBefore(now, 61);
    expect(isIdleTodoTaskWakeCooldownActive({ lastWakeAt, now })).toBe(false);
  });
});

describe("shouldWakeIdleTodoTask", () => {
  const staleIssue = {
    id: issueId,
    status: "todo",
    assigneeAgentId: agentId,
    updatedAt: minutesBefore(now, 15),
  };

  it("wakes a stale, idle, invokable, uncooled candidate", () => {
    expect(
      shouldWakeIdleTodoTask({
        issue: staleIssue,
        now,
        hasLiveExecutionPath: false,
        agentInvokable: true,
        lastWakeAt: null,
      }),
    ).toBe(true);
  });

  it("does not wake a fresh (not yet idle) issue", () => {
    expect(
      shouldWakeIdleTodoTask({
        issue: { ...staleIssue, updatedAt: minutesBefore(now, 2) },
        now,
        hasLiveExecutionPath: false,
        agentInvokable: true,
        lastWakeAt: null,
      }),
    ).toBe(false);
  });

  it("does not wake when a run or wake is already live for the issue", () => {
    expect(
      shouldWakeIdleTodoTask({
        issue: staleIssue,
        now,
        hasLiveExecutionPath: true,
        agentInvokable: true,
        lastWakeAt: null,
      }),
    ).toBe(false);
  });

  it("does not wake a paused (non-invokable) assignee", () => {
    expect(
      shouldWakeIdleTodoTask({
        issue: staleIssue,
        now,
        hasLiveExecutionPath: false,
        agentInvokable: false,
        lastWakeAt: null,
      }),
    ).toBe(false);
  });

  it("does not wake twice inside one hour for the same task", () => {
    expect(
      shouldWakeIdleTodoTask({
        issue: staleIssue,
        now,
        hasLiveExecutionPath: false,
        agentInvokable: true,
        lastWakeAt: minutesBefore(now, 10),
      }),
    ).toBe(false);
  });

  it("wakes again once the hourly cooldown has elapsed", () => {
    expect(
      shouldWakeIdleTodoTask({
        issue: staleIssue,
        now,
        hasLiveExecutionPath: false,
        agentInvokable: true,
        lastWakeAt: minutesBefore(now, 61),
      }),
    ).toBe(true);
  });

  it("does not wake a non-todo status even if otherwise stale", () => {
    expect(
      shouldWakeIdleTodoTask({
        issue: { ...staleIssue, status: "blocked" },
        now,
        hasLiveExecutionPath: false,
        agentInvokable: true,
        lastWakeAt: null,
      }),
    ).toBe(false);
  });
});

describe("buildIdleTodoTaskWakeIdempotencyKey", () => {
  it("includes the reason, issue id, and timestamp", () => {
    const key = buildIdleTodoTaskWakeIdempotencyKey(issueId, now.toISOString());
    expect(key).toBe(`${IDLE_TODO_TASK_WAKE_REASON}:${issueId}:${now.toISOString()}`);
  });
});

describe("constants", () => {
  it("idle threshold is 10 minutes and cooldown is 1 hour", () => {
    expect(IDLE_TODO_TASK_IDLE_THRESHOLD_MS).toBe(10 * 60 * 1000);
    expect(IDLE_TODO_TASK_WAKE_COOLDOWN_MS).toBe(60 * 60 * 1000);
  });
});
