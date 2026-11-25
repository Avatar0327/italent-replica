CREATE TABLE "onboarding_preparation_assignees" (
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "onboarding_preparation_assignees_tenant_id_task_id_user_id_pk" PRIMARY KEY("tenant_id","task_id","user_id"),
	CONSTRAINT "onboarding_prep_assignee_status" CHECK ("onboarding_preparation_assignees"."status" IN ('open', 'completed', 'revoked')
      AND (("onboarding_preparation_assignees"."status" = 'open') = ("onboarding_preparation_assignees"."ended_at" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "onboarding_preparation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"category" text NOT NULL,
	"code" text NOT NULL,
	"fields" jsonb NOT NULL,
	CONSTRAINT "onboarding_prep_items_tenant_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_prep_items_code" UNIQUE("tenant_id","category","code"),
	CONSTRAINT "onboarding_prep_items_valid" CHECK ("onboarding_preparation_items"."revision" > 0 AND (NOT "onboarding_preparation_items"."archived" OR NOT "onboarding_preparation_items"."enabled")),
	CONSTRAINT "onboarding_prep_items_category" CHECK ("onboarding_preparation_items"."category" IN ('employee_code', 'work_email', 'other'))
);
--> statement-breakpoint
CREATE TABLE "onboarding_preparation_rule_assignees" (
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"position_id" uuid,
	"post_id" uuid,
	"profile_id" uuid,
	CONSTRAINT "onboarding_preparation_rule_assignees_tenant_id_rule_id_ordinal_pk" PRIMARY KEY("tenant_id","rule_id","ordinal"),
	CONSTRAINT "onboarding_prep_selector_shape" CHECK (("onboarding_preparation_rule_assignees"."kind" = 'member' AND "onboarding_preparation_rule_assignees"."user_id" IS NOT NULL
        OR "onboarding_preparation_rule_assignees"."kind" = 'position' AND "onboarding_preparation_rule_assignees"."position_id" IS NOT NULL
        OR "onboarding_preparation_rule_assignees"."kind" = 'post' AND "onboarding_preparation_rule_assignees"."post_id" IS NOT NULL
        OR "onboarding_preparation_rule_assignees"."kind" = 'identity' AND "onboarding_preparation_rule_assignees"."profile_id" IS NOT NULL
        OR "onboarding_preparation_rule_assignees"."kind" IN ('direct_manager', 'department_head', 'hrbp')
          AND num_nonnulls("onboarding_preparation_rule_assignees"."user_id", "onboarding_preparation_rule_assignees"."position_id", "onboarding_preparation_rule_assignees"."post_id", "onboarding_preparation_rule_assignees"."profile_id") = 0)
        AND num_nonnulls("onboarding_preparation_rule_assignees"."user_id", "onboarding_preparation_rule_assignees"."position_id", "onboarding_preparation_rule_assignees"."post_id", "onboarding_preparation_rule_assignees"."profile_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "onboarding_preparation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"conditions" jsonb NOT NULL,
	"start_days_before" integer,
	"remind_days_before" integer,
	CONSTRAINT "onboarding_prep_rules_tenant_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_prep_rules_item_key" UNIQUE("tenant_id","item_id","id"),
	CONSTRAINT "onboarding_prep_rules_valid" CHECK ("onboarding_preparation_rules"."revision" > 0 AND (NOT "onboarding_preparation_rules"."archived" OR NOT "onboarding_preparation_rules"."enabled")),
	CONSTRAINT "onboarding_prep_rules_priority" CHECK ("onboarding_preparation_rules"."priority" >= 0),
	CONSTRAINT "onboarding_prep_rules_start" CHECK ("onboarding_preparation_rules"."start_days_before" BETWEEN 1 AND 365),
	CONSTRAINT "onboarding_prep_rules_remind" CHECK ("onboarding_preparation_rules"."remind_days_before" BETWEEN 1 AND 365)
);
--> statement-breakpoint
CREATE TABLE "onboarding_preparation_scope_orgs" (
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	CONSTRAINT "onboarding_preparation_scope_orgs_tenant_id_rule_id_org_id_pk" PRIMARY KEY("tenant_id","rule_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "onboarding_preparation_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"case_revision" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"next_due_on" date,
	"next_remind_on" date,
	"start_days_before" integer,
	"remind_days_before" integer,
	"rule_snapshot" jsonb NOT NULL,
	"form_snapshot" jsonb NOT NULL,
	"result" jsonb,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "onboarding_prep_task_tenant_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_prep_task_status" CHECK ("onboarding_preparation_tasks"."status" IN ('scheduled', 'open', 'completed', 'closed')
        AND (("onboarding_preparation_tasks"."status" = 'scheduled') = ("onboarding_preparation_tasks"."next_due_on" IS NOT NULL))
        AND (("onboarding_preparation_tasks"."status" = 'completed') = ("onboarding_preparation_tasks"."completed_by" IS NOT NULL AND "onboarding_preparation_tasks"."completed_at" IS NOT NULL))
        AND ("onboarding_preparation_tasks"."completed_by" IS NULL) = ("onboarding_preparation_tasks"."completed_at" IS NULL)),
	CONSTRAINT "onboarding_prep_task_revision" CHECK ("onboarding_preparation_tasks"."revision" > 0 AND "onboarding_preparation_tasks"."case_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "onboarding_preparation_assignees" ADD CONSTRAINT "onboarding_preparation_assignees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_assignees" ADD CONSTRAINT "onboarding_prep_assignee_task_fk" FOREIGN KEY ("tenant_id","task_id") REFERENCES "public"."onboarding_preparation_tasks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_assignees" ADD CONSTRAINT "onboarding_prep_assignee_member_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_items" ADD CONSTRAINT "onboarding_preparation_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_items" ADD CONSTRAINT "onboarding_prep_items_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_items" ADD CONSTRAINT "onboarding_prep_items_updater_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_rule_assignees" ADD CONSTRAINT "onboarding_preparation_rule_assignees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_rule_assignees" ADD CONSTRAINT "onboarding_prep_selector_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."onboarding_preparation_rules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_rule_assignees" ADD CONSTRAINT "onboarding_prep_selector_member_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_rule_assignees" ADD CONSTRAINT "onboarding_prep_selector_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_rule_assignees" ADD CONSTRAINT "onboarding_prep_selector_post_fk" FOREIGN KEY ("tenant_id","post_id") REFERENCES "public"."job_post_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_rule_assignees" ADD CONSTRAINT "onboarding_prep_selector_identity_fk" FOREIGN KEY ("tenant_id","profile_id") REFERENCES "public"."permission_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_rules" ADD CONSTRAINT "onboarding_preparation_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_rules" ADD CONSTRAINT "onboarding_prep_rules_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_rules" ADD CONSTRAINT "onboarding_prep_rules_updater_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_rules" ADD CONSTRAINT "onboarding_prep_rules_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."onboarding_preparation_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_scope_orgs" ADD CONSTRAINT "onboarding_preparation_scope_orgs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_scope_orgs" ADD CONSTRAINT "onboarding_prep_scope_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."onboarding_preparation_rules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_scope_orgs" ADD CONSTRAINT "onboarding_prep_scope_org_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_tasks" ADD CONSTRAINT "onboarding_preparation_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_tasks" ADD CONSTRAINT "onboarding_prep_task_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."onboarding_entry_cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_tasks" ADD CONSTRAINT "onboarding_prep_task_rule_fk" FOREIGN KEY ("tenant_id","item_id","rule_id") REFERENCES "public"."onboarding_preparation_rules"("tenant_id","item_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_tasks" ADD CONSTRAINT "onboarding_prep_task_finisher_fk" FOREIGN KEY ("tenant_id","completed_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_tasks" ADD CONSTRAINT "onboarding_prep_task_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_preparation_tasks" ADD CONSTRAINT "onboarding_prep_task_updater_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_prep_my_tasks" ON "onboarding_preparation_assignees" USING btree ("tenant_id","user_id","status","task_id");--> statement-breakpoint
CREATE INDEX "onboarding_prep_rules_match" ON "onboarding_preparation_rules" USING btree ("tenant_id","enabled","item_id","priority");--> statement-breakpoint
CREATE INDEX "onboarding_prep_scope_org" ON "onboarding_preparation_scope_orgs" USING btree ("tenant_id","org_id","rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_prep_task_current" ON "onboarding_preparation_tasks" USING btree ("tenant_id","case_id","item_id") WHERE "onboarding_preparation_tasks"."status" <> 'closed';--> statement-breakpoint
CREATE INDEX "onboarding_prep_task_case" ON "onboarding_preparation_tasks" USING btree ("tenant_id","case_id","status");--> statement-breakpoint
CREATE INDEX "onboarding_prep_task_due" ON "onboarding_preparation_tasks" USING btree ("tenant_id","status","next_due_on","id");
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_preparation_items');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_preparation_rules');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_preparation_scope_orgs');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_preparation_rule_assignees');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_preparation_tasks');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_preparation_assignees');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON onboarding_preparation_items, onboarding_preparation_rules,
  onboarding_preparation_tasks, onboarding_preparation_assignees TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON onboarding_preparation_scope_orgs, onboarding_preparation_rule_assignees TO app_user;
