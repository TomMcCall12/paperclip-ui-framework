CREATE TABLE "issue_title_namings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"naming_version" integer DEFAULT 0 NOT NULL,
	"naming_issue_id" uuid,
	"naming_run_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"model" text,
	"title_at_start" text,
	"named_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_title_namings_status_check" CHECK ("issue_title_namings"."status" in ('pending', 'generating', 'ready', 'failed', 'skipped')),
	CONSTRAINT "issue_title_namings_counters_check" CHECK ("issue_title_namings"."naming_version" >= 0 and "issue_title_namings"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "title_source" text DEFAULT 'explicit' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_title_namings" ADD CONSTRAINT "issue_title_namings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_title_namings" ADD CONSTRAINT "issue_title_namings_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_title_namings" ADD CONSTRAINT "issue_title_namings_naming_issue_company_fk" FOREIGN KEY ("company_id","naming_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_title_namings" ADD CONSTRAINT "issue_title_namings_naming_run_company_fk" FOREIGN KEY ("company_id","naming_run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_title_namings_issue_uq" ON "issue_title_namings" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_title_namings_status_next_attempt_idx" ON "issue_title_namings" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_title_source_check" CHECK ("issues"."title_source" in ('explicit', 'derived', 'ai'));