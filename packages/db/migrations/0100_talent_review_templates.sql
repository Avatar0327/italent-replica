CREATE TABLE "talent_review_template_module_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "talent_review_template_module_fields_field" UNIQUE("tenant_id","module_id","field_id")
);
--> statement-breakpoint
CREATE TABLE "talent_review_template_module_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	"min_score" numeric(14, 4),
	"max_score" numeric(14, 4),
	"min_count" integer,
	CONSTRAINT "talent_review_template_module_levels_source" CHECK ("talent_review_template_module_levels"."source" IN ('rule','grade'))
);
--> statement-breakpoint
CREATE TABLE "talent_review_template_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	"source" text,
	"criterion_mode" text,
	"criterion_id" uuid,
	"dimension_types" text[],
	"scoring" text,
	"rule_kind" text,
	"rule_min" numeric(14, 4),
	"rule_max" numeric(14, 4),
	"rule_display" text,
	"rule_allow_unable" boolean,
	"source_score_rule_id" uuid,
	"source_module_grade_id" uuid,
	"allow_org" boolean,
	"allow_position" boolean,
	"allow_target" boolean,
	CONSTRAINT "talent_review_template_modules_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_template_modules_name" UNIQUE("tenant_id","version_id","name"),
	CONSTRAINT "talent_review_template_modules_kind" CHECK ("talent_review_template_modules"."kind" IN ('indicator','info','succession')),
	CONSTRAINT "talent_review_template_modules_source" CHECK ("talent_review_template_modules"."source" IS NULL OR "talent_review_template_modules"."source" IN ('qualification','talent_standard')),
	CONSTRAINT "talent_review_template_modules_criterion_mode" CHECK ("talent_review_template_modules"."criterion_mode" IS NULL OR "talent_review_template_modules"."criterion_mode" IN ('designated','by_job')),
	CONSTRAINT "talent_review_template_modules_scoring" CHECK ("talent_review_template_modules"."scoring" IS NULL OR "talent_review_template_modules"."scoring" IN ('weighted_sum','arithmetic_mean','arithmetic_sum','by_count')),
	CONSTRAINT "talent_review_template_modules_rule_kind" CHECK ("talent_review_template_modules"."rule_kind" IS NULL OR "talent_review_template_modules"."rule_kind" IN ('numeric','grade'))
);
--> statement-breakpoint
CREATE TABLE "talent_review_template_step_module_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"role_id" uuid,
	"module_id" uuid NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"score_enabled" boolean DEFAULT true NOT NULL,
	"score_required" boolean DEFAULT false NOT NULL,
	"comment_enabled" boolean DEFAULT true NOT NULL,
	"comment_required" boolean DEFAULT false NOT NULL,
	"weight" numeric(7, 4),
	"successor_access" text,
	"target_access" text,
	CONSTRAINT "talent_review_template_step_module_permissions_seat" UNIQUE NULLS NOT DISTINCT("tenant_id","step_id","role_id","module_id"),
	CONSTRAINT "talent_review_template_step_module_permissions_access" CHECK (("talent_review_template_step_module_permissions"."successor_access" IS NULL OR "talent_review_template_step_module_permissions"."successor_access" IN ('edit','view','hidden'))
        AND ("talent_review_template_step_module_permissions"."target_access" IS NULL OR "talent_review_template_step_module_permissions"."target_access" IN ('edit','view','hidden'))),
	CONSTRAINT "talent_review_template_step_module_permissions_weight" CHECK ("talent_review_template_step_module_permissions"."weight" IS NULL OR ("talent_review_template_step_module_permissions"."weight" >= 0 AND "talent_review_template_step_module_permissions"."weight" <= 100))
);
--> statement-breakpoint
CREATE TABLE "talent_review_template_step_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"resolver" text NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "talent_review_template_step_roles_role" UNIQUE("tenant_id","step_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "talent_review_template_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"step_type" text NOT NULL,
	"mode" text NOT NULL,
	"show_matrix" boolean DEFAULT false NOT NULL,
	"allow_return" boolean DEFAULT false NOT NULL,
	"allow_transfer" boolean DEFAULT false NOT NULL,
	"allow_disagree" boolean DEFAULT false NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "talent_review_template_steps_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_template_steps_key" UNIQUE("tenant_id","version_id","node_key"),
	CONSTRAINT "talent_review_template_steps_kind" CHECK ("talent_review_template_steps"."kind" IN ('single','countersign')),
	CONSTRAINT "talent_review_template_steps_step_type" CHECK ("talent_review_template_steps"."step_type" IN ('evaluate','calibrate')),
	CONSTRAINT "talent_review_template_steps_mode" CHECK ("talent_review_template_steps"."mode" IN ('single','batch')),
	CONSTRAINT "talent_review_template_steps_countersign" CHECK ("talent_review_template_steps"."kind" <> 'countersign' OR ("talent_review_template_steps"."step_type" = 'evaluate' AND "talent_review_template_steps"."mode" = 'single'))
);
--> statement-breakpoint
CREATE TABLE "talent_review_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"flow_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_template_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_template_versions_no" UNIQUE("tenant_id","template_id","version_no"),
	CONSTRAINT "talent_review_template_versions_no_pos" CHECK ("talent_review_template_versions"."version_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "talent_review_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"downward_public" boolean DEFAULT false NOT NULL,
	"flow_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"current_version_no" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_templates_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_templates_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "talent_review_templates_enabled_flow" CHECK (NOT "talent_review_templates"."enabled" OR "talent_review_templates"."flow_id" IS NOT NULL),
	CONSTRAINT "talent_review_templates_version" CHECK ("talent_review_templates"."current_version_no" > 0),
	CONSTRAINT "talent_review_templates_rev" CHECK ("talent_review_templates"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "talent_review_template_module_fields" ADD CONSTRAINT "talent_review_template_module_fields_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_module_fields" ADD CONSTRAINT "talent_review_template_module_fields_module_fk" FOREIGN KEY ("tenant_id","module_id") REFERENCES "public"."talent_review_template_modules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_module_fields" ADD CONSTRAINT "talent_review_template_module_fields_field_fk" FOREIGN KEY ("tenant_id","field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_module_levels" ADD CONSTRAINT "talent_review_template_module_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_module_levels" ADD CONSTRAINT "talent_review_template_module_levels_module_fk" FOREIGN KEY ("tenant_id","module_id") REFERENCES "public"."talent_review_template_modules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_modules" ADD CONSTRAINT "talent_review_template_modules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_modules" ADD CONSTRAINT "talent_review_template_modules_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."talent_review_template_versions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_modules" ADD CONSTRAINT "talent_review_template_modules_rule_fk" FOREIGN KEY ("tenant_id","source_score_rule_id") REFERENCES "public"."talent_review_score_rules"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_modules" ADD CONSTRAINT "talent_review_template_modules_grade_fk" FOREIGN KEY ("tenant_id","source_module_grade_id") REFERENCES "public"."talent_review_module_grades"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_step_module_permissions" ADD CONSTRAINT "talent_review_template_step_module_permissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_step_module_permissions" ADD CONSTRAINT "talent_review_template_step_module_permissions_step_fk" FOREIGN KEY ("tenant_id","step_id") REFERENCES "public"."talent_review_template_steps"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_step_module_permissions" ADD CONSTRAINT "talent_review_template_step_module_permissions_module_fk" FOREIGN KEY ("tenant_id","module_id") REFERENCES "public"."talent_review_template_modules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_step_module_permissions" ADD CONSTRAINT "talent_review_template_step_module_permissions_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."talent_review_roles"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_step_roles" ADD CONSTRAINT "talent_review_template_step_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_step_roles" ADD CONSTRAINT "talent_review_template_step_roles_step_fk" FOREIGN KEY ("tenant_id","step_id") REFERENCES "public"."talent_review_template_steps"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_step_roles" ADD CONSTRAINT "talent_review_template_step_roles_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."talent_review_roles"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_steps" ADD CONSTRAINT "talent_review_template_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_steps" ADD CONSTRAINT "talent_review_template_steps_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."talent_review_template_versions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_versions" ADD CONSTRAINT "talent_review_template_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_versions" ADD CONSTRAINT "talent_review_template_versions_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."talent_review_templates"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_templates" ADD CONSTRAINT "talent_review_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_templates" ADD CONSTRAINT "talent_review_templates_org_fk" FOREIGN KEY ("tenant_id","owner_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_templates" ADD CONSTRAINT "talent_review_templates_flow_fk" FOREIGN KEY ("tenant_id","flow_id") REFERENCES "public"."talent_review_flows"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "talent_review_templates_org" ON "talent_review_templates" USING btree ("tenant_id","owner_org_id");
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_templates');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_template_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_template_steps');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_template_step_roles');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_template_modules');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_template_module_levels');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_template_module_fields');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_template_step_module_permissions');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_review_templates, talent_review_template_versions, talent_review_template_steps, talent_review_template_step_roles, talent_review_template_modules, talent_review_template_module_levels, talent_review_template_module_fields, talent_review_template_step_module_permissions TO app_user;
