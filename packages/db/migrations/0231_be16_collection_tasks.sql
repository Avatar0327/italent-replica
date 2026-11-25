CREATE TABLE "onboarding_collection_comments" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "onboarding_collection_comment_text" CHECK (length(btrim("onboarding_collection_comments"."text")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "onboarding_collection_jobs" (
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "onboarding_collection_jobs_tenant_id_case_id_pk" PRIMARY KEY("tenant_id","case_id"),
	CONSTRAINT "onboarding_collection_job_status" CHECK ("onboarding_collection_jobs"."status" IN ('pending','done','skipped','failed')),
	CONSTRAINT "onboarding_collection_job_attempts" CHECK ("onboarding_collection_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "onboarding_collection_tasks" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"template_revision" integer NOT NULL,
	"rule_revision" integer NOT NULL,
	"fields" jsonb NOT NULL,
	"required_subsets" jsonb NOT NULL,
	"verification_mode" text NOT NULL,
	"requires_approval" boolean NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"next_remind_on" date,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "onboarding_collection_task_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_collection_task_status" CHECK ("onboarding_collection_tasks"."status" IN ('ready','sent','draft','in_review','returned','rehire_pending','completed','closed','withdrawn')),
	CONSTRAINT "onboarding_collection_task_verification" CHECK ("onboarding_collection_tasks"."verification_mode" IN ('independent_channel','phone_otp')),
	CONSTRAINT "onboarding_collection_task_revisions" CHECK ("onboarding_collection_tasks"."revision" > 0 AND "onboarding_collection_tasks"."template_revision" > 0 AND "onboarding_collection_tasks"."rule_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "onboarding_collection_comments" ADD CONSTRAINT "onboarding_collection_comment_task_fk" FOREIGN KEY ("tenant_id","task_id") REFERENCES "public"."onboarding_collection_tasks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_comments" ADD CONSTRAINT "onboarding_collection_comment_author_fk" FOREIGN KEY ("tenant_id","author_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_jobs" ADD CONSTRAINT "onboarding_collection_job_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."onboarding_entry_cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_tasks" ADD CONSTRAINT "onboarding_collection_task_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."onboarding_entry_cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_tasks" ADD CONSTRAINT "onboarding_collection_task_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."onboarding_collection_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_tasks" ADD CONSTRAINT "onboarding_collection_task_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."onboarding_collection_rules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_tasks" ADD CONSTRAINT "onboarding_collection_task_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_tasks" ADD CONSTRAINT "onboarding_collection_task_updater_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_collection_comment_task" ON "onboarding_collection_comments" USING btree ("tenant_id","task_id","created_at","id");--> statement-breakpoint
CREATE INDEX "onboarding_collection_job_due" ON "onboarding_collection_jobs" USING btree ("tenant_id","next_attempt_at","case_id") WHERE "onboarding_collection_jobs"."status" IN ('pending','failed');--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_collection_task_active" ON "onboarding_collection_tasks" USING btree ("tenant_id","case_id") WHERE "onboarding_collection_tasks"."status" IN ('ready','sent','draft','in_review','returned','rehire_pending');--> statement-breakpoint
CREATE INDEX "onboarding_collection_task_case" ON "onboarding_collection_tasks" USING btree ("tenant_id","case_id","created_at","id");--> statement-breakpoint
CREATE INDEX "onboarding_collection_task_template" ON "onboarding_collection_tasks" USING btree ("tenant_id","template_id");--> statement-breakpoint
CREATE INDEX "onboarding_collection_task_rule" ON "onboarding_collection_tasks" USING btree ("tenant_id","rule_id");--> statement-breakpoint
CREATE INDEX "onboarding_collection_task_remind" ON "onboarding_collection_tasks" USING btree ("tenant_id","status","next_remind_on","id");
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_collection_tasks');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_collection_comments');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_collection_jobs');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON onboarding_collection_tasks, onboarding_collection_jobs TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON onboarding_collection_comments TO app_user;
