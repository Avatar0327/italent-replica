CREATE TABLE "onboarding_entry_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"root_business_id" uuid NOT NULL,
	"current_business_id" uuid NOT NULL,
	"state" varchar DEFAULT 'pending' NOT NULL,
	"pending_date" date NOT NULL,
	"hired_record_id" uuid,
	"hired_on" date,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "onboarding_entry_cases_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_entry_cases_root" UNIQUE("tenant_id","root_business_id"),
	CONSTRAINT "onboarding_entry_cases_current" UNIQUE("tenant_id","current_business_id"),
	CONSTRAINT "onboarding_entry_cases_hired_record" UNIQUE("tenant_id","hired_record_id"),
	CONSTRAINT "onboarding_entry_cases_state_valid" CHECK ("onboarding_entry_cases"."state" IN ('pending','cancelled','hired','deleted')),
	CONSTRAINT "onboarding_entry_cases_revision_positive" CHECK ("onboarding_entry_cases"."revision" > 0),
	CONSTRAINT "onboarding_entry_cases_dates_finite" CHECK (isfinite("onboarding_entry_cases"."pending_date") AND ("onboarding_entry_cases"."hired_on" IS NULL OR isfinite("onboarding_entry_cases"."hired_on"))),
	CONSTRAINT "onboarding_entry_cases_hire_valid" CHECK (("onboarding_entry_cases"."state" = 'hired' AND "onboarding_entry_cases"."hired_on" IS NOT NULL AND "onboarding_entry_cases"."hired_record_id" IS NOT NULL)
        OR ("onboarding_entry_cases"."state" <> 'hired' AND "onboarding_entry_cases"."hired_on" IS NULL AND "onboarding_entry_cases"."hired_record_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "approval_instances" DROP CONSTRAINT "approval_instances_business_type";--> statement-breakpoint
ALTER TABLE "onboarding_entry_cases" ADD CONSTRAINT "onboarding_entry_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_entry_cases" ADD CONSTRAINT "onboarding_entry_cases_root_fk" FOREIGN KEY ("tenant_id","employee_id","root_business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_entry_cases" ADD CONSTRAINT "onboarding_entry_cases_current_fk" FOREIGN KEY ("tenant_id","employee_id","current_business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_entry_cases" ADD CONSTRAINT "onboarding_entry_cases_hired_record_fk" FOREIGN KEY ("tenant_id","employee_id","hired_record_id") REFERENCES "public"."employment_records"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_entry_cases" ADD CONSTRAINT "onboarding_entry_cases_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_entry_cases" ADD CONSTRAINT "onboarding_entry_cases_updater_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_entry_cases_state_date" ON "onboarding_entry_cases" USING btree ("tenant_id","state","pending_date","id");--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_business_type" CHECK ("approval_instances"."business_type" IN ('employment','personnel_change','contract','idp','talent_review','part_time',
        'offer','offer_batch','probation_assessment','retirement_intention','org_adjustment',
        'exit_handover','entry_info_collection'));
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_entry_cases');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON onboarding_entry_cases TO app_user;
