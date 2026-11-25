CREATE TABLE "onboarding_collection_submissions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"business_revision" integer NOT NULL,
	"case_revision" integer NOT NULL,
	"kind" text NOT NULL,
	"department_id" uuid NOT NULL,
	"pending_date" date NOT NULL,
	"values" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "onboarding_collection_submission_kind" CHECK ("onboarding_collection_submissions"."kind" IN ('draft','submit')),
	CONSTRAINT "onboarding_collection_submission_revisions" CHECK ("onboarding_collection_submissions"."version" > 0 AND "onboarding_collection_submissions"."business_revision" > 0 AND "onboarding_collection_submissions"."case_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "onboarding_collection_tasks" ADD COLUMN "approval_instance_id" uuid;--> statement-breakpoint
ALTER TABLE "onboarding_collection_tasks" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "onboarding_collection_tasks" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "onboarding_collection_submissions" ADD CONSTRAINT "onboarding_collection_submission_task_fk" FOREIGN KEY ("tenant_id","task_id") REFERENCES "public"."onboarding_collection_tasks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_submissions" ADD CONSTRAINT "onboarding_collection_submission_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_submissions" ADD CONSTRAINT "onboarding_collection_submission_author_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_submissions" ADD CONSTRAINT "onboarding_collection_submission_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_collection_submission_version" ON "onboarding_collection_submissions" USING btree ("tenant_id","task_id","version");--> statement-breakpoint
CREATE INDEX "onboarding_collection_submission_business" ON "onboarding_collection_submissions" USING btree ("tenant_id","employee_id","business_id");--> statement-breakpoint
CREATE INDEX "onboarding_collection_submission_author" ON "onboarding_collection_submissions" USING btree ("tenant_id","created_by");--> statement-breakpoint
CREATE INDEX "onboarding_collection_submission_department" ON "onboarding_collection_submissions" USING btree ("tenant_id","department_id");--> statement-breakpoint
ALTER TABLE "onboarding_collection_tasks" ADD CONSTRAINT "onboarding_collection_task_approval_fk" FOREIGN KEY ("tenant_id","approval_instance_id") REFERENCES "public"."approval_instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_tasks" ADD CONSTRAINT "onboarding_collection_task_approval" UNIQUE("tenant_id","approval_instance_id");
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_collection_submissions');
--> statement-breakpoint
GRANT SELECT, INSERT ON onboarding_collection_submissions TO app_user;
