CREATE TABLE "lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"root_issue_id" uuid NOT NULL,
	"name" text,
	"naming_status" text DEFAULT 'pending' NOT NULL,
	"naming_version" integer DEFAULT 0 NOT NULL,
	"naming_issue_id" uuid,
	"naming_attempts" integer DEFAULT 0 NOT NULL,
	"next_naming_attempt_at" timestamp with time zone,
	"last_naming_error_code" text,
	"naming_model" text,
	"naming_run_id" uuid,
	"named_at" timestamp with time zone,
	"created_by_type" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lines_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "lines_naming_status_check" CHECK ("lines"."naming_status" in ('pending', 'generating', 'ready', 'failed')),
	CONSTRAINT "lines_naming_counters_check" CHECK ("lines"."naming_version" >= 0 and "lines"."naming_attempts" >= 0),
	CONSTRAINT "lines_name_check" CHECK ("lines"."name" is null or (char_length("lines"."name") <= 80 and "lines"."name" ~ '^[^[:space:]]+( [^[:space:]]+){1,5}$')),
	CONSTRAINT "lines_creator_check" CHECK (("lines"."created_by_type" = 'agent' and "lines"."created_by_agent_id" is not null and "lines"."created_by_user_id" is null) or ("lines"."created_by_type" = 'user' and "lines"."created_by_agent_id" is null and "lines"."created_by_user_id" is not null) or ("lines"."created_by_type" = 'system' and "lines"."created_by_agent_id" is null and "lines"."created_by_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "line_id" uuid;--> statement-breakpoint
-- A referenced composite key must exist before Line run-provenance FKs are added.
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "lines" ADD CONSTRAINT "lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lines" ADD CONSTRAINT "lines_root_company_fk" FOREIGN KEY ("company_id","root_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lines" ADD CONSTRAINT "lines_naming_issue_company_fk" FOREIGN KEY ("company_id","naming_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lines" ADD CONSTRAINT "lines_creator_agent_company_fk" FOREIGN KEY ("company_id","created_by_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lines" ADD CONSTRAINT "lines_creator_run_company_fk" FOREIGN KEY ("company_id","created_by_run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lines" ADD CONSTRAINT "lines_naming_run_company_fk" FOREIGN KEY ("company_id","naming_run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lines_company_root_uq" ON "lines" USING btree ("company_id","root_issue_id");--> statement-breakpoint
CREATE INDEX "lines_company_archive_updated_idx" ON "lines" USING btree ("company_id","archived_at","updated_at","id");--> statement-breakpoint
CREATE INDEX "issues_company_line_idx" ON "issues" USING btree ("company_id","line_id");--> statement-breakpoint
-- This closes the issues/lines schema cycle after both tables exist.
ALTER TABLE "issues" ADD CONSTRAINT "issues_line_company_fk" FOREIGN KEY ("company_id","line_id") REFERENCES "public"."lines"("company_id","id") ON DELETE no action ON UPDATE no action;
