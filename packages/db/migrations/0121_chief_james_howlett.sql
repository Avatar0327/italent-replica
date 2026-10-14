CREATE TABLE "ev_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"staff_evaluation_id" uuid,
	"recipient_employee_id" uuid,
	"kind" text NOT NULL,
	"template_code" text,
	"dedupe_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ev_notifications_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ev_notifications_dedupe" UNIQUE("tenant_id","dedupe_key"),
	CONSTRAINT "ev_notifications_state" CHECK ("ev_notifications"."state" IN ('pending','sent','failed','unknown'))
);
--> statement-breakpoint
CREATE TABLE "ev_staff_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"target_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"initiator_user_id" uuid NOT NULL,
	"nominator_employee_id" uuid,
	"applied_at" timestamp with time zone,
	"original_category_id" uuid,
	"original_level_id" uuid,
	"last_result" text,
	"experience" numeric,
	"apply_category_id" uuid NOT NULL,
	"apply_level_id" uuid NOT NULL,
	"standard_id" uuid,
	"condition_result" jsonb,
	"exception" boolean DEFAULT false NOT NULL,
	"exception_reason" text,
	"current_stage" text DEFAULT 'apply' NOT NULL,
	"apply_status" text DEFAULT 'draft' NOT NULL,
	"material_status" text,
	"defense_status" text,
	"result_status" text,
	"qualification_instance_id" uuid,
	"material_instance_id" uuid,
	"self_evaluation" text,
	"manager_evaluation" text,
	"hrbp_evaluation" text,
	"defense_material" text,
	"defense_material_updated_by" uuid,
	"defense_material_updated_at" timestamp with time zone,
	"final_score" numeric(18, 2),
	"final_result" text,
	"pass_votes" integer,
	"strengths" text,
	"suggestions" text,
	"effective_date" date,
	"terminated_at" timestamp with time zone,
	"terminated_reason" text,
	"published_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ev_staff_evaluations_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ev_staff_evaluations_activity_id" UNIQUE("tenant_id","activity_id","id"),
	CONSTRAINT "ev_staff_evaluations_source" CHECK ("ev_staff_evaluations"."source" IN ('self', 'nominated', 'batch')),
	CONSTRAINT "ev_staff_evaluations_version" CHECK ("ev_staff_evaluations"."target_version">0 AND "ev_staff_evaluations"."revision">0),
	CONSTRAINT "ev_staff_evaluations_stage" CHECK ("ev_staff_evaluations"."current_stage" IN ('apply','material','defense','result')),
	CONSTRAINT "ev_staff_evaluations_apply" CHECK ("ev_staff_evaluations"."apply_status" IN ('draft','reviewing','passed','failed')),
	CONSTRAINT "ev_staff_evaluations_material" CHECK ("ev_staff_evaluations"."material_status" IN ('pending','reviewing','passed','failed')),
	CONSTRAINT "ev_staff_evaluations_defense" CHECK ("ev_staff_evaluations"."defense_status" IN ('unscheduled','scheduled','reviewed','calibrated')),
	CONSTRAINT "ev_staff_evaluations_result" CHECK ("ev_staff_evaluations"."result_status" IN ('pending','published')),
	CONSTRAINT "ev_staff_evaluations_termination" CHECK (("ev_staff_evaluations"."terminated_at" IS NULL AND "ev_staff_evaluations"."terminated_reason" IS NULL)
    OR ("ev_staff_evaluations"."terminated_at" IS NOT NULL AND "ev_staff_evaluations"."terminated_reason" IS NOT NULL
      AND "ev_staff_evaluations"."terminated_reason" IN ('leave','activity_completed','revoked')))
);
--> statement-breakpoint
ALTER TABLE "ev_notifications" ADD CONSTRAINT "ev_notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_notifications" ADD CONSTRAINT "ev_notifications_tenant_id_activity_id_ev_activities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."ev_activities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_notifications" ADD CONSTRAINT "ev_notifications_tenant_id_activity_id_staff_evaluation_id_ev_staff_evaluations_tenant_id_activity_id_id_fk" FOREIGN KEY ("tenant_id","activity_id","staff_evaluation_id") REFERENCES "public"."ev_staff_evaluations"("tenant_id","activity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_notifications" ADD CONSTRAINT "ev_notifications_tenant_id_recipient_employee_id_employment_employees_tenant_id_id_fk" FOREIGN KEY ("tenant_id","recipient_employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_staff_evaluations" ADD CONSTRAINT "ev_staff_evaluations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_staff_evaluations" ADD CONSTRAINT "ev_staff_evaluations_cycle_fk" FOREIGN KEY ("tenant_id","employee_id","cycle_id") REFERENCES "public"."employment_cycles"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_staff_evaluations" ADD CONSTRAINT "ev_staff_evaluations_tenant_id_activity_id_ev_activities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."ev_activities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_staff_evaluations" ADD CONSTRAINT "ev_staff_evaluations_tenant_id_nominator_employee_id_employment_employees_tenant_id_id_fk" FOREIGN KEY ("tenant_id","nominator_employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_staff_evaluations" ADD CONSTRAINT "ev_staff_evaluations_tenant_id_initiator_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","initiator_user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_staff_evaluations" ADD CONSTRAINT "ev_staff_evaluations_tenant_id_defense_material_updated_by_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","defense_material_updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_staff_evaluations" ADD CONSTRAINT "ev_staff_evaluations_tenant_id_original_category_id_ql_categories_tenant_id_id_fk" FOREIGN KEY ("tenant_id","original_category_id") REFERENCES "public"."ql_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_staff_evaluations" ADD CONSTRAINT "ev_staff_evaluations_tenant_id_original_level_id_ql_levels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","original_level_id") REFERENCES "public"."ql_levels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_staff_evaluations" ADD CONSTRAINT "ev_staff_evaluations_tenant_id_apply_category_id_ql_categories_tenant_id_id_fk" FOREIGN KEY ("tenant_id","apply_category_id") REFERENCES "public"."ql_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_staff_evaluations" ADD CONSTRAINT "ev_staff_evaluations_tenant_id_apply_level_id_ql_levels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","apply_level_id") REFERENCES "public"."ql_levels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_staff_evaluations" ADD CONSTRAINT "ev_staff_evaluations_tenant_id_standard_id_ql_standards_tenant_id_id_fk" FOREIGN KEY ("tenant_id","standard_id") REFERENCES "public"."ql_standards"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_staff_evaluations" ADD CONSTRAINT "ev_staff_evaluations_tenant_id_qualification_instance_id_approval_instances_tenant_id_id_fk" FOREIGN KEY ("tenant_id","qualification_instance_id") REFERENCES "public"."approval_instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_staff_evaluations" ADD CONSTRAINT "ev_staff_evaluations_tenant_id_material_instance_id_approval_instances_tenant_id_id_fk" FOREIGN KEY ("tenant_id","material_instance_id") REFERENCES "public"."approval_instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ev_staff_evaluations_activity" ON "ev_staff_evaluations" USING btree ("tenant_id","activity_id","id");--> statement-breakpoint
CREATE INDEX "ev_staff_evaluations_cycle" ON "ev_staff_evaluations" USING btree ("tenant_id","cycle_id");
--> statement-breakpoint
SELECT enable_tenant_isolation('ev_staff_evaluations');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ev_staff_evaluations" TO app_user;

--> statement-breakpoint
SELECT enable_tenant_isolation('ev_notifications');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ev_notifications" TO app_user;
