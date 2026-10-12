CREATE TABLE "issue_scheduled_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	"notes" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_triggered_at" timestamp with time zone,
	"wake_requested_at" timestamp with time zone,
	"recurrence_cron" text,
	"recurrence_timezone" text,
	"cancel_on_comment" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_scheduled_checks_status_check" CHECK ("issue_scheduled_checks"."status" in ('scheduled', 'fired', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "issue_scheduled_checks" ADD CONSTRAINT "issue_scheduled_checks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_scheduled_checks" ADD CONSTRAINT "issue_scheduled_checks_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_scheduled_checks" ADD CONSTRAINT "issue_scheduled_checks_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_scheduled_checks_company_due_idx" ON "issue_scheduled_checks" USING btree ("company_id","next_check_at") WHERE "issue_scheduled_checks"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "issue_scheduled_checks_issue_status_idx" ON "issue_scheduled_checks" USING btree ("issue_id","status");--> statement-breakpoint
CREATE INDEX "issue_scheduled_checks_issue_primary_idx" ON "issue_scheduled_checks" USING btree ("issue_id","is_primary");
--> statement-breakpoint
-- TOM-413: issues used to support at most one scheduled check-in, tracked on
-- the issue row itself (issues.monitor_next_check_at / monitor_notes /
-- monitor_scheduled_by / monitor_attempt_count / monitor_last_triggered_at).
-- Move any existing monitor into its own primary row here so multi-row
-- dispatch and the Properties panel list pick it up immediately. The
-- issues.monitor_* columns and the executionPolicy.monitor PATCH path are
-- left in place for back-compat; new writes through that path upsert the
-- matching primary row going forward (see
-- syncPrimaryScheduledCheckFromExecutionPolicy in
-- server/src/services/issue-scheduled-checks.ts).
INSERT INTO issue_scheduled_checks (
	company_id, issue_id, next_check_at, notes, created_by_agent_id,
	status, attempt_count, last_triggered_at, is_primary, created_at, updated_at
)
SELECT
	i.company_id,
	i.id,
	i.monitor_next_check_at,
	i.monitor_notes,
	CASE WHEN i.monitor_scheduled_by = 'assignee' THEN i.assignee_agent_id ELSE NULL END,
	'scheduled',
	COALESCE(i.monitor_attempt_count, 0),
	i.monitor_last_triggered_at,
	true,
	now(),
	now()
FROM issues i
WHERE i.monitor_next_check_at IS NOT NULL;