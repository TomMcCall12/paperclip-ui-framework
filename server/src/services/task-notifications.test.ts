import { describe, expect, it } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import {
  formatTaskNotification,
  plainSummary,
  taskNotificationKind,
  taskStatusChangeFromEvent,
} from "./task-notifications.js";

const topLevel = { parentId: null, originKind: "manual", conversationAgentId: null, isExternalChat: false };
const change = (toStatus: string, actorType = "agent", fromStatus = "in_progress") => ({ actorType, fromStatus, toStatus });

describe("taskStatusChangeFromEvent", () => {
  const event = (payload: Record<string, unknown>): LiveEvent =>
    ({ id: 1, companyId: "c1", type: "activity.logged", createdAt: "", payload }) as LiveEvent;

  it("reads the status change from an issue.updated activity", () => {
    expect(taskStatusChangeFromEvent(event({
      action: "issue.updated", entityType: "issue", entityId: "i1", actorType: "agent",
      details: { status: "done", changes: { status: { from: "in_progress", to: "done" } } },
    }))).toEqual({ companyId: "c1", issueId: "i1", actorType: "agent", fromStatus: "in_progress", toStatus: "done" });
  });

  it("ignores other activity and updates that don't change status", () => {
    expect(taskStatusChangeFromEvent(event({ action: "issue.comment_added", entityType: "issue", entityId: "i1" }))).toBeNull();
    expect(taskStatusChangeFromEvent(event({
      action: "issue.updated", entityType: "issue", entityId: "i1", details: { changes: { title: { from: "a", to: "b" } } },
    }))).toBeNull();
  });
});

describe("taskNotificationKind", () => {
  it("announces an agent finishing, blocking on or handing back a top-level task", () => {
    expect(taskNotificationKind(change("done"), topLevel)).toBe("done");
    expect(taskNotificationKind(change("blocked"), topLevel)).toBe("blocked");
    expect(taskNotificationKind(change("in_review"), topLevel)).toBe("needs_review");
    expect(taskNotificationKind(change("in_progress", "agent", "todo"), topLevel)).toBeNull();
  });

  it("stays quiet about the board's own changes, sub-tasks and chats", () => {
    expect(taskNotificationKind(change("done", "user"), topLevel)).toBeNull();
    expect(taskNotificationKind(change("done"), { ...topLevel, parentId: "p1" })).toBeNull();
    expect(taskNotificationKind(change("done"), { ...topLevel, conversationAgentId: "a1" })).toBeNull();
    expect(taskNotificationKind(change("done"), { ...topLevel, isExternalChat: true })).toBeNull();
  });

  it("announces routine runs only when they need the board", () => {
    const routine = { ...topLevel, originKind: "routine_execution" };
    expect(taskNotificationKind(change("done"), routine)).toBeNull();
    expect(taskNotificationKind(change("blocked"), routine)).toBe("blocked");
  });
});

describe("message", () => {
  it("keeps the plain-English opening and drops technical detail and markdown", () => {
    const summary = plainSummary("**Done.** The `hermes_zimaboard` key was not used.\n\n### Technical details\nsecret stuff");
    expect(summary).toBe("Done. The hermes_zimaboard key was not used.");
  });

  it("formats a short Telegram message with the task link", () => {
    expect(formatTaskNotification({
      kind: "done", identifier: "TOM-110", title: "Category additions", summary: "Six categories added.", url: "http://lab/issues/TOM-110",
    })).toBe("✅ Done · TOM-110: Category additions\n\nSix categories added.\n\nhttp://lab/issues/TOM-110");
  });

  it("shortens long summaries at a sentence", () => {
    const summary = plainSummary(`${"This sentence is padding. ".repeat(40)}`);
    expect(summary.length).toBeLessThanOrEqual(501);
    expect(summary.endsWith("…")).toBe(true);
  });
});
