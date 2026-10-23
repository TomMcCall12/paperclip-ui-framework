import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/** AI task-title naming state, one row per target issue. Written only by the task naming service. */
export const issueTitleNamings = pgTable("issue_title_namings", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull(),
  status: text("status").$type<"pending" | "generating" | "ready" | "failed" | "skipped">().notNull().default("pending"),
  namingVersion: integer("naming_version").notNull().default(0),
  namingIssueId: uuid("naming_issue_id"),
  namingRunId: uuid("naming_run_id"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  model: text("model"),
  titleAtStart: text("title_at_start"),
  namedAt: timestamp("named_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  issueUq: uniqueIndex("issue_title_namings_issue_uq").on(table.issueId),
  statusNextAttemptIdx: index("issue_title_namings_status_next_attempt_idx").on(table.status, table.nextAttemptAt),
  issueCompanyFk: foreignKey({ columns: [table.companyId, table.issueId], foreignColumns: [issues.companyId, issues.id], name: "issue_title_namings_issue_company_fk" }).onDelete("cascade"),
  namingIssueCompanyFk: foreignKey({ columns: [table.companyId, table.namingIssueId], foreignColumns: [issues.companyId, issues.id], name: "issue_title_namings_naming_issue_company_fk" }),
  namingRunCompanyFk: foreignKey({ columns: [table.companyId, table.namingRunId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id], name: "issue_title_namings_naming_run_company_fk" }),
  statusCheck: check("issue_title_namings_status_check", sql`${table.status} in ('pending', 'generating', 'ready', 'failed', 'skipped')`),
  countersCheck: check("issue_title_namings_counters_check", sql`${table.namingVersion} >= 0 and ${table.attempts} >= 0`),
}));
