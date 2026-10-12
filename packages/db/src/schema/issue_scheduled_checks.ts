import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * A single scheduled check-in on an issue. An issue can have any number of
 * these (unlike the legacy single `issues.monitor_*` columns). Each row is
 * dispatched independently by the heartbeat scheduler; see
 * `tickDueIssueScheduledChecks` in `server/src/services/heartbeat.ts`.
 *
 * The row with `isPrimary = true` for a given (issueId, creator) mirrors the
 * back-compat `executionPolicy.monitor` field on `issues` so existing agents
 * and skills that only know about that field keep working — see
 * `syncPrimaryScheduledCheckFromExecutionPolicy` in
 * `server/src/services/issue-scheduled-checks.ts`.
 */
export const issueScheduledChecks = pgTable(
  "issue_scheduled_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull(),
    notes: text("notes"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    status: text("status").notNull().default("scheduled"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    wakeRequestedAt: timestamp("wake_requested_at", { withTimezone: true }),
    recurrenceCron: text("recurrence_cron"),
    recurrenceTimezone: text("recurrence_timezone"),
    cancelOnComment: boolean("cancel_on_comment").notNull().default(false),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    /**
     * True for the single row per (issueId, creator) that mirrors the legacy
     * `executionPolicy.monitor` back-compat field. See file doc comment.
     */
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      "issue_scheduled_checks_status_check",
      sql`${table.status} in ('scheduled', 'fired', 'cancelled')`,
    ),
    // Replaces `issues_company_monitor_due_idx` for the new multi-row model.
    // Partial on status so cancelled/fired rows never cost the dispatch scan.
    companyDueIdx: index("issue_scheduled_checks_company_due_idx")
      .on(table.companyId, table.nextCheckAt)
      .where(sql`${table.status} = 'scheduled'`),
    issueStatusIdx: index("issue_scheduled_checks_issue_status_idx").on(table.issueId, table.status),
    issuePrimaryIdx: index("issue_scheduled_checks_issue_primary_idx").on(table.issueId, table.isPrimary),
  }),
);
