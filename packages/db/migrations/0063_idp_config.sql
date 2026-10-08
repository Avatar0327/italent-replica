CREATE TABLE "idp_processes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"org_id" uuid NOT NULL,
	"public_down" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_processes_tenant_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "idp_sub_processes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"approval_type" text NOT NULL,
	"approval_process_id" uuid NOT NULL,
	"start_mode" text NOT NULL,
	"start_time_type" text,
	"fixed_date" date,
	"reference_point" text,
	"start_from" text,
	"days" integer,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_sub_processes_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "idp_sub_processes_seq" UNIQUE("tenant_id","process_id","seq"),
	CONSTRAINT "idp_sub_processes_seq_positive" CHECK ("idp_sub_processes"."seq" > 0),
	CONSTRAINT "idp_sub_processes_category" CHECK ("idp_sub_processes"."category" IN ('plan', 'review', 'evaluation')),
	CONSTRAINT "idp_sub_processes_approval_type" CHECK ("idp_sub_processes"."approval_type" IN ('idp_plan', 'idp_mid_review', 'idp_final_review')),
	CONSTRAINT "idp_sub_processes_start_mode" CHECK ("idp_sub_processes"."start_mode" IN ('auto', 'manual')),
	CONSTRAINT "idp_sub_processes_start_time_type" CHECK ("idp_sub_processes"."start_time_type" IS NULL OR "idp_sub_processes"."start_time_type" IN ('fixed', 'relative')),
	CONSTRAINT "idp_sub_processes_reference_point" CHECK ("idp_sub_processes"."reference_point" IS NULL OR "idp_sub_processes"."reference_point" IN ('plan_start', 'plan_end', 'previous_end', 'employment_effective')),
	CONSTRAINT "idp_sub_processes_start_from" CHECK ("idp_sub_processes"."start_from" IS NULL OR "idp_sub_processes"."start_from" IN ('same_day', 'before', 'after')),
	CONSTRAINT "idp_sub_processes_days" CHECK ("idp_sub_processes"."days" IS NULL OR "idp_sub_processes"."days" BETWEEN 1 AND 3650),
	CONSTRAINT "idp_sub_processes_manual_rule" CHECK ("idp_sub_processes"."start_mode" = 'auto' OR ("idp_sub_processes"."start_time_type" IS NULL AND "idp_sub_processes"."fixed_date" IS NULL
        AND "idp_sub_processes"."reference_point" IS NULL AND "idp_sub_processes"."start_from" IS NULL AND "idp_sub_processes"."days" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "idp_template_common_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"name" text NOT NULL,
	"measure" text,
	"suggestion" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_template_common_goals_tenant_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "idp_template_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"module_type" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"allow_custom_goal" boolean,
	"allow_library_goal" boolean,
	"competency_source" text,
	"goal_review_enabled" boolean,
	"task_enabled" boolean,
	"check_none_goal" boolean,
	"key_info_sources" text[],
	"review_time_basis" text,
	"plan_time_basis" text,
	"review_category_ids" uuid[],
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_template_modules_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "idp_template_modules_type" CHECK ("idp_template_modules"."module_type" IN ('basic', 'key_info', 'goal', 'review', 'summary', 'talent_review', 'analysis')),
	CONSTRAINT "idp_template_modules_competency_source" CHECK ("idp_template_modules"."competency_source" IS NULL OR "idp_template_modules"."competency_source" IN ('current_position', 'succession_position', 'rotation_position', 'promotion_position', 'talent_pool')),
	CONSTRAINT "idp_template_modules_review_basis" CHECK (("idp_template_modules"."review_time_basis" IS NULL OR "idp_template_modules"."review_time_basis" IN ('project_start', 'project_end'))
        AND ("idp_template_modules"."plan_time_basis" IS NULL OR "idp_template_modules"."plan_time_basis" IN ('plan_start', 'plan_end')))
);
--> statement-breakpoint
CREATE TABLE "idp_template_node_settings" (
	"tenant_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"sub_process_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"seq" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"buttons" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "idp_template_node_settings_tenant_id_module_id_sub_process_id_node_key_pk" PRIMARY KEY("tenant_id","module_id","sub_process_id","node_key"),
	CONSTRAINT "idp_template_node_settings_buttons" CHECK ("idp_template_node_settings"."buttons" <@ ARRAY['RowAddIdpGoal','RowEditIdpGoal','RowDeleteIdpGoal','EditModuleContent']::text[])
);
--> statement-breakpoint
CREATE TABLE "idp_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"org_id" uuid NOT NULL,
	"public_down" boolean DEFAULT true NOT NULL,
	"process_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_templates_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "idp_templates_status" CHECK ("idp_templates"."status" IN ('draft', 'published'))
);
--> statement-breakpoint
ALTER TABLE "idp_processes" ADD CONSTRAINT "idp_processes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_processes" ADD CONSTRAINT "idp_processes_org_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_sub_processes" ADD CONSTRAINT "idp_sub_processes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_sub_processes" ADD CONSTRAINT "idp_sub_processes_process_fk" FOREIGN KEY ("tenant_id","process_id") REFERENCES "public"."idp_processes"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_sub_processes" ADD CONSTRAINT "idp_sub_processes_approval_fk" FOREIGN KEY ("tenant_id","approval_process_id") REFERENCES "public"."approval_processes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_template_common_goals" ADD CONSTRAINT "idp_template_common_goals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_template_common_goals" ADD CONSTRAINT "idp_template_common_goals_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."idp_templates"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_template_common_goals" ADD CONSTRAINT "idp_template_common_goals_module_fk" FOREIGN KEY ("tenant_id","module_id") REFERENCES "public"."idp_template_modules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_template_modules" ADD CONSTRAINT "idp_template_modules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_template_modules" ADD CONSTRAINT "idp_template_modules_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."idp_templates"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_template_node_settings" ADD CONSTRAINT "idp_template_node_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_template_node_settings" ADD CONSTRAINT "idp_template_node_settings_module_fk" FOREIGN KEY ("tenant_id","module_id") REFERENCES "public"."idp_template_modules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_template_node_settings" ADD CONSTRAINT "idp_template_node_settings_sub_process_fk" FOREIGN KEY ("tenant_id","sub_process_id") REFERENCES "public"."idp_sub_processes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_templates" ADD CONSTRAINT "idp_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_templates" ADD CONSTRAINT "idp_templates_process_fk" FOREIGN KEY ("tenant_id","process_id") REFERENCES "public"."idp_processes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_templates" ADD CONSTRAINT "idp_templates_org_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idp_processes_org" ON "idp_processes" USING btree ("tenant_id","org_id");--> statement-breakpoint
CREATE INDEX "idp_sub_processes_approval" ON "idp_sub_processes" USING btree ("tenant_id","approval_process_id");--> statement-breakpoint
CREATE INDEX "idp_template_common_goals_template" ON "idp_template_common_goals" USING btree ("tenant_id","template_id");--> statement-breakpoint
CREATE INDEX "idp_template_modules_template" ON "idp_template_modules" USING btree ("tenant_id","template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idp_template_modules_singleton" ON "idp_template_modules" USING btree ("tenant_id","template_id","module_type") WHERE "idp_template_modules"."module_type" IN ('basic', 'key_info');--> statement-breakpoint
CREATE INDEX "idp_template_node_settings_sub_process" ON "idp_template_node_settings" USING btree ("tenant_id","sub_process_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idp_templates_name" ON "idp_templates" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "idp_templates_process" ON "idp_templates" USING btree ("tenant_id","process_id");--> statement-breakpoint
CREATE INDEX "idp_templates_org" ON "idp_templates" USING btree ("tenant_id","org_id");--> statement-breakpoint
-- R3-T07：IDP 配置表统一租户隔离（AGENTS §2 租户隔离）
SELECT enable_tenant_isolation('idp_processes');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_processes TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('idp_sub_processes');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_sub_processes TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('idp_templates');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_templates TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('idp_template_modules');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_template_modules TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('idp_template_node_settings');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_template_node_settings TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('idp_template_common_goals');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_template_common_goals TO app_user;
