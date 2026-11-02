CREATE TABLE "employment_regularization_drafts" (
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"form_id" text DEFAULT 'standard' NOT NULL,
	"anchor_id" uuid,
	"saved" boolean DEFAULT false NOT NULL,
	"effective_date" date,
	"probation_result" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"saved_by_user_id" uuid,
	"command_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_regularization_drafts_pk" PRIMARY KEY("tenant_id","employee_id","form_id"),
	CONSTRAINT "employment_regularization_drafts_revision_positive" CHECK ("employment_regularization_drafts"."revision" > 0),
	CONSTRAINT "employment_regularization_drafts_cleared" CHECK ("employment_regularization_drafts"."saved" OR ("employment_regularization_drafts"."effective_date" IS NULL AND "employment_regularization_drafts"."probation_result" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "employment_regularization_results" ADD COLUMN "version_no" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "employment_regularization_results" ADD COLUMN "result_name" text;--> statement-breakpoint
ALTER TABLE "employment_regularization_drafts" ADD CONSTRAINT "employment_regularization_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_regularization_drafts" ADD CONSTRAINT "employment_regularization_drafts_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_regularization_results" DROP CONSTRAINT "employment_regularization_results_pk";
--> statement-breakpoint
ALTER TABLE "employment_regularization_results" ADD CONSTRAINT "employment_regularization_results_pk" PRIMARY KEY("tenant_id","business_id","version_no");--> statement-breakpoint
ALTER TABLE "employment_regularization_results" ADD CONSTRAINT "employment_regularization_results_version_positive" CHECK ("employment_regularization_results"."version_no" > 0);
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_regularization_drafts');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON employment_regularization_drafts TO app_user;
