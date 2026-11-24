CREATE TABLE "onboarding_integration_schemes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" jsonb NOT NULL,
	"priority" integer NOT NULL,
	"description" text,
	"failure_recipient_id" uuid,
	"conditions" jsonb NOT NULL,
	"scope_key" text NOT NULL,
	"reminder_days" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "onboarding_scheme_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_scheme_priority_scope" UNIQUE("tenant_id","priority","scope_key"),
	CONSTRAINT "onboarding_scheme_values" CHECK ("onboarding_integration_schemes"."priority" >= 0 AND "onboarding_integration_schemes"."revision" > 0
      AND "onboarding_integration_schemes"."reminder_days" > 0 AND char_length("onboarding_integration_schemes"."description") <= 500
      AND jsonb_typeof("onboarding_integration_schemes"."name") = 'object' AND jsonb_typeof("onboarding_integration_schemes"."conditions") = 'object')
);
--> statement-breakpoint
CREATE TABLE "onboarding_integration_scope_orgs" (
	"tenant_id" uuid NOT NULL,
	"scheme_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	CONSTRAINT "onboarding_scope_org_pk" PRIMARY KEY("tenant_id","scheme_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "onboarding_integration_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"auto_start" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "onboarding_integration_settings_revision" CHECK ("onboarding_integration_settings"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "onboarding_integration_stage_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"pool_task_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"start_unit" text NOT NULL,
	"start_ordinal" integer NOT NULL,
	"due_unit" text NOT NULL,
	"due_ordinal" integer NOT NULL,
	"assignee_type" text NOT NULL,
	"assignee_role" text,
	"assignee_user_id" uuid,
	"assignee_position_id" uuid,
	"assignee_post_id" uuid,
	"assignee_profile_id" uuid,
	"employee_visible" boolean NOT NULL,
	"reminder_days" integer,
	CONSTRAINT "onboarding_stage_task_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_stage_task_dates" CHECK ("onboarding_integration_stage_tasks"."start_unit" IN ('day','week','month') AND "onboarding_integration_stage_tasks"."due_unit" IN ('day','week','month')
    AND "onboarding_integration_stage_tasks"."start_ordinal" > 0 AND "onboarding_integration_stage_tasks"."due_ordinal" > 0),
	CONSTRAINT "onboarding_stage_task_reminder" CHECK ("onboarding_integration_stage_tasks"."reminder_days" >= 0),
	CONSTRAINT "onboarding_stage_task_assignee" CHECK (
      ("onboarding_integration_stage_tasks"."assignee_type" = 'member') = ("onboarding_integration_stage_tasks"."assignee_user_id" IS NOT NULL)
      AND ("onboarding_integration_stage_tasks"."assignee_type" = 'role') = ("onboarding_integration_stage_tasks"."assignee_role" IS NOT NULL)
      AND "onboarding_integration_stage_tasks"."assignee_role" IN ('department_head','direct_manager','mentor','hrbp')
      AND ("onboarding_integration_stage_tasks"."assignee_type" = 'position') = ("onboarding_integration_stage_tasks"."assignee_position_id" IS NOT NULL)
      AND ("onboarding_integration_stage_tasks"."assignee_type" = 'post') = ("onboarding_integration_stage_tasks"."assignee_post_id" IS NOT NULL)
      AND ("onboarding_integration_stage_tasks"."assignee_type" = 'identity') = ("onboarding_integration_stage_tasks"."assignee_profile_id" IS NOT NULL)
      AND ("onboarding_integration_stage_tasks"."assignee_type" <> 'employee' OR "onboarding_integration_stage_tasks"."employee_visible")
      AND "onboarding_integration_stage_tasks"."assignee_type" IN ('member','role','position','post','identity','employee'))
);
--> statement-breakpoint
CREATE TABLE "onboarding_integration_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scheme_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"name" text NOT NULL,
	"start_unit" text NOT NULL,
	"start_ordinal" integer NOT NULL,
	"due_unit" text NOT NULL,
	"due_ordinal" integer NOT NULL,
	CONSTRAINT "onboarding_stage_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_stage_dates" CHECK ("onboarding_integration_stages"."start_unit" IN ('day','week','month') AND "onboarding_integration_stages"."due_unit" IN ('day','week','month')
    AND "onboarding_integration_stages"."start_ordinal" > 0 AND "onboarding_integration_stages"."due_ordinal" > 0)
);
--> statement-breakpoint
ALTER TABLE "onboarding_integration_schemes" ADD CONSTRAINT "onboarding_integration_schemes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_schemes" ADD CONSTRAINT "onboarding_scheme_recipient_fk" FOREIGN KEY ("tenant_id","failure_recipient_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_schemes" ADD CONSTRAINT "onboarding_scheme_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_schemes" ADD CONSTRAINT "onboarding_scheme_updater_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_scope_orgs" ADD CONSTRAINT "onboarding_scope_org_scheme_fk" FOREIGN KEY ("tenant_id","scheme_id") REFERENCES "public"."onboarding_integration_schemes"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_scope_orgs" ADD CONSTRAINT "onboarding_scope_org_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_settings" ADD CONSTRAINT "onboarding_integration_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_settings" ADD CONSTRAINT "onboarding_integration_settings_updater_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_stage_tasks" ADD CONSTRAINT "onboarding_stage_task_stage_fk" FOREIGN KEY ("tenant_id","stage_id") REFERENCES "public"."onboarding_integration_stages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_stage_tasks" ADD CONSTRAINT "onboarding_stage_task_pool_fk" FOREIGN KEY ("tenant_id","pool_task_id") REFERENCES "public"."onboarding_integration_task_pool"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_stage_tasks" ADD CONSTRAINT "onboarding_stage_task_member_fk" FOREIGN KEY ("tenant_id","assignee_user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_stage_tasks" ADD CONSTRAINT "onboarding_stage_task_position_fk" FOREIGN KEY ("tenant_id","assignee_position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_stage_tasks" ADD CONSTRAINT "onboarding_stage_task_post_fk" FOREIGN KEY ("tenant_id","assignee_post_id") REFERENCES "public"."job_post_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_stage_tasks" ADD CONSTRAINT "onboarding_stage_task_profile_fk" FOREIGN KEY ("tenant_id","assignee_profile_id") REFERENCES "public"."permission_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_stages" ADD CONSTRAINT "onboarding_stage_scheme_fk" FOREIGN KEY ("tenant_id","scheme_id") REFERENCES "public"."onboarding_integration_schemes"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_scope_org_match" ON "onboarding_integration_scope_orgs" USING btree ("tenant_id","org_id","scheme_id");--> statement-breakpoint
CREATE INDEX "onboarding_stage_task_order" ON "onboarding_integration_stage_tasks" USING btree ("tenant_id","stage_id","sequence","id");--> statement-breakpoint
CREATE INDEX "onboarding_stage_task_pool" ON "onboarding_integration_stage_tasks" USING btree ("tenant_id","pool_task_id");--> statement-breakpoint
CREATE INDEX "onboarding_stage_order" ON "onboarding_integration_stages" USING btree ("tenant_id","scheme_id","sequence","id");
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_integration_schemes');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_integration_scope_orgs');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_integration_stages');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_integration_stage_tasks');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_integration_settings');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_integration_schemes, onboarding_integration_scope_orgs,
  onboarding_integration_stages, onboarding_integration_stage_tasks, onboarding_integration_settings TO app_user;
