ALTER TABLE "issues" ADD COLUMN "step_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "issues_open_step_key_uq" ON "issues" USING btree ("company_id","parent_id","step_key") WHERE "issues"."step_key" is not null
          and "issues"."parent_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."status" not in ('done', 'cancelled');