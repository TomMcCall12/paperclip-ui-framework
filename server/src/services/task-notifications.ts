import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatConversations, issueComments, issues } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { publicChatTaskUrl } from "./chat-task-url.js";
import { subscribeAllCompanyLiveEvents } from "./live-events.js";

/**
 * Task notifications: when an agent finishes one of the board's tasks, blocks
 * on it or hands it back for review, message the board through the company's
 * Telegram bot so they don't have to keep checking Paperclip.
 *
 * Only top-level tasks are announced: delegated sub-tasks, chats (which reply
 * in their own thread) and routine runs (unless they need the board) stay quiet.
 * Changes the board makes itself are never announced back to it.
 */

export type TaskNotificationKind = "done" | "blocked" | "needs_review" | "cancelled";

export type TaskStatusChange = {
  actorType: string;
  fromStatus: string | null;
  toStatus: string;
};

export type TaskForNotification = {
  parentId: string | null;
  originKind: string;
  conversationAgentId: string | null;
  isExternalChat: boolean;
};

const KIND_BY_STATUS: Record<string, TaskNotificationKind> = {
  done: "done",
  blocked: "blocked",
  in_review: "needs_review",
  cancelled: "cancelled",
};

/** Reads a status change out of an `issue.updated` activity event, if it has one. */
export function taskStatusChangeFromEvent(event: LiveEvent): (TaskStatusChange & { companyId: string; issueId: string }) | null {
  if (event.type !== "activity.logged") return null;
  const payload = event.payload as Record<string, unknown>;
  if (payload.action !== "issue.updated" || payload.entityType !== "issue") return null;
  const details = (payload.details ?? {}) as Record<string, unknown>;
  const changes = (details.changes ?? {}) as Record<string, unknown>;
  const status = (changes.status ?? null) as { from?: unknown; to?: unknown } | null;
  if (!status || typeof status.to !== "string") return null;
  return {
    companyId: event.companyId,
    issueId: String(payload.entityId),
    actorType: String(payload.actorType ?? ""),
    fromStatus: typeof status.from === "string" ? status.from : null,
    toStatus: status.to,
  };
}

/** Whether this status change on this task is worth a message to the board. */
export function taskNotificationKind(change: TaskStatusChange, task: TaskForNotification): TaskNotificationKind | null {
  const kind = KIND_BY_STATUS[change.toStatus];
  if (!kind || change.fromStatus === change.toStatus) return null;
  // The board changed it themselves; they already know.
  if (change.actorType === "user") return null;
  if (task.parentId || task.conversationAgentId || task.isExternalChat) return null;
  // Routine runs are routine: only interrupt the board when one needs them.
  if (task.originKind.startsWith("routine") && kind !== "blocked" && kind !== "needs_review") return null;
  return kind;
}

const HEADLINE: Record<TaskNotificationKind, string> = {
  done: "✅ Done",
  blocked: "⛔ Blocked",
  needs_review: "👀 Needs you",
  cancelled: "✖️ Cancelled",
};

const SUMMARY_LIMIT = 500;

/** The plain-English opening of an agent's comment, without the technical section or markdown. */
export function plainSummary(markdown: string | null | undefined): string {
  if (!markdown) return "";
  const beforeTechnical = markdown.split(/^#{1,6}\s*Technical details/im)[0] ?? "";
  const text = beforeTechnical
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[#>\-*\s]+/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= SUMMARY_LIMIT) return text;
  const cut = text.slice(0, SUMMARY_LIMIT);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return `${(lastStop > 200 ? cut.slice(0, lastStop + 1) : cut).trim()}…`;
}

export function formatTaskNotification(input: {
  kind: TaskNotificationKind;
  identifier: string | null;
  title: string;
  summary: string;
  url: string | null;
}): string {
  const label = input.identifier ? `${input.identifier}: ${input.title}` : input.title;
  return [`${HEADLINE[input.kind]} · ${label}`, input.summary, input.url ?? ""]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export function startTaskNotifications(
  db: Db,
  options: {
    isEnabled: () => Promise<boolean>;
    send: (companyId: string, text: string) => Promise<{ sent: boolean; reason?: string }>;
    taskUrl?: (identifierOrId: string) => string | null;
  },
): () => void {
  const recent = new Map<string, number>();
  const taskUrl = options.taskUrl ?? publicChatTaskUrl;

  async function handle(change: TaskStatusChange & { companyId: string; issueId: string }) {
    if (!(await options.isEnabled())) return;
    const [task] = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        parentId: issues.parentId,
        originKind: issues.originKind,
        conversationAgentId: issues.conversationAgentId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, change.companyId), eq(issues.id, change.issueId)));
    if (!task) return;
    const [externalChat] = await db
      .select({ id: chatConversations.id })
      .from(chatConversations)
      .where(and(eq(chatConversations.companyId, change.companyId), eq(chatConversations.issueId, task.id)))
      .limit(1);
    const kind = taskNotificationKind(change, { ...task, isExternalChat: Boolean(externalChat) });
    if (!kind) return;

    const key = `${task.id}:${change.toStatus}`;
    const now = Date.now();
    if ((recent.get(key) ?? 0) > now - DEDUPE_WINDOW_MS) return;
    recent.set(key, now);
    for (const [entry, at] of recent) if (at <= now - DEDUPE_WINDOW_MS) recent.delete(entry);

    const [latest] = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, task.id), isNotNull(issueComments.authorAgentId)))
      .orderBy(desc(issueComments.createdAt))
      .limit(1);
    const text = formatTaskNotification({
      kind,
      identifier: task.identifier,
      title: task.title,
      summary: plainSummary(latest?.body),
      url: taskUrl(task.identifier ?? task.id),
    });
    const result = await options.send(change.companyId, text);
    if (!result.sent) {
      logger.warn({ issueId: task.id, kind, reason: result.reason }, "task notification not sent");
    }
  }

  return subscribeAllCompanyLiveEvents((event) => {
    const change = taskStatusChangeFromEvent(event);
    if (!change) return;
    void handle(change).catch((err) => {
      logger.warn({ err, issueId: change.issueId }, "task notification failed");
    });
  });
}
