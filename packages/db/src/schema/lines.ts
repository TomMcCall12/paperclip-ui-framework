import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/** Membership and naming state are written by the Line service, never inferred by a migration. */
export const lines = pgTable("lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  rootIssueId: uuid("root_issue_id").notNull(),
  name: text("name"),
  namingStatus: text("naming_status").$type<"pending" | "generating" | "ready" | "failed">().notNull().default("pending"),
  namingVersion: integer("naming_version").notNull().default(0),
  namingIssueId: uuid("naming_issue_id"),
  namingAttempts: integer("naming_attempts").notNull().default(0),
  nextNamingAttemptAt: timestamp("next_naming_attempt_at", { withTimezone: true }),
  lastNamingErrorCode: text("last_naming_error_code"),
  namingModel: text("naming_model"),
  namingRunId: uuid("naming_run_id"),
  namedAt: timestamp("named_at", { withTimezone: true }),
  createdByType: text("created_by_type").$type<"agent" | "user" | "system">().notNull(),
  createdByAgentId: uuid("created_by_agent_id"),
  createdByUserId: text("created_by_user_id"),
  createdByRunId: uuid("created_by_run_id"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyIdUq: unique("lines_company_id_uq").on(table.companyId, table.id),
  rootUq: uniqueIndex("lines_company_root_uq").on(table.companyId, table.rootIssueId),
  listIdx: index("lines_company_archive_updated_idx").on(table.companyId, table.archivedAt, table.updatedAt, table.id),
  rootCompanyFk: foreignKey({ columns: [table.companyId, table.rootIssueId], foreignColumns: [issues.companyId, issues.id], name: "lines_root_company_fk" }),
  namingIssueCompanyFk: foreignKey({ columns: [table.companyId, table.namingIssueId], foreignColumns: [issues.companyId, issues.id], name: "lines_naming_issue_company_fk" }),
  creatorAgentCompanyFk: foreignKey({ columns: [table.companyId, table.createdByAgentId], foreignColumns: [agents.companyId, agents.id], name: "lines_creator_agent_company_fk" }),
  creatorRunCompanyFk: foreignKey({ columns: [table.companyId, table.createdByRunId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id], name: "lines_creator_run_company_fk" }),
  namingRunCompanyFk: foreignKey({ columns: [table.companyId, table.namingRunId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id], name: "lines_naming_run_company_fk" }),
  namingStatusCheck: check("lines_naming_status_check", sql`${table.namingStatus} in ('pending', 'generating', 'ready', 'failed')`),
  namingCountersCheck: check("lines_naming_counters_check", sql`${table.namingVersion} >= 0 and ${table.namingAttempts} >= 0`),
  nameCheck: check("lines_name_check", sql`${table.name} is null or (char_length(${table.name}) <= 80 and ${table.name} ~ '^[^[:space:]]+( [^[:space:]]+){1,5}$')`),
  creatorCheck: check("lines_creator_check", sql`(${table.createdByType} = 'agent' and ${table.createdByAgentId} is not null and ${table.createdByUserId} is null) or (${table.createdByType} = 'user' and ${table.createdByAgentId} is null and ${table.createdByUserId} is not null) or (${table.createdByType} = 'system' and ${table.createdByAgentId} is null and ${table.createdByUserId} is null)`),
}));
