CREATE TABLE "talent_review_template_form_fields" (
	"tenant_id" uuid NOT NULL,
	"step_form_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"access" text NOT NULL,
	"required" boolean NOT NULL,
	"sort_no" integer NOT NULL,
	CONSTRAINT "talent_review_template_form_fields_tenant_id_step_form_id_field_id_pk" PRIMARY KEY("tenant_id","step_form_id","field_id"),
	CONSTRAINT "tr_template_form_access" CHECK ("talent_review_template_form_fields"."access" IN ('hidden','view','edit') AND (NOT "talent_review_template_form_fields"."required" OR "talent_review_template_form_fields"."access" = 'edit'))
);
--> statement-breakpoint
CREATE TABLE "talent_review_template_result_module_refs" (
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	CONSTRAINT "talent_review_template_result_module_refs_tenant_id_rule_id_module_id_pk" PRIMARY KEY("tenant_id","rule_id","module_id")
);
--> statement-breakpoint
CREATE TABLE "talent_review_template_result_refs" (
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	CONSTRAINT "talent_review_template_result_refs_tenant_id_rule_id_field_id_pk" PRIMARY KEY("tenant_id","rule_id","field_id")
);
--> statement-breakpoint
CREATE TABLE "talent_review_template_result_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"target_field_id" uuid NOT NULL,
	"formula" text NOT NULL,
	"priority" integer NOT NULL,
	"sort_no" integer NOT NULL,
	CONSTRAINT "tr_result_rules_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "tr_result_rules_target" UNIQUE("tenant_id","version_id","target_field_id"),
	CONSTRAINT "tr_result_rules_priority" CHECK ("talent_review_template_result_rules"."priority" BETWEEN 0 AND 1000000)
);
--> statement-breakpoint
CREATE TABLE "talent_review_template_step_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"role_id" uuid,
	"purpose" text NOT NULL,
	"form_id" uuid NOT NULL,
	"sort_no" integer NOT NULL,
	CONSTRAINT "tr_step_forms_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "tr_step_forms_seat" UNIQUE NULLS NOT DISTINCT("tenant_id","step_id","role_id","purpose"),
	CONSTRAINT "tr_step_forms_purpose" CHECK ("talent_review_template_step_forms"."purpose" IN ('info','calibrate_edit','successor_edit','target_edit'))
);
--> statement-breakpoint
ALTER TABLE "talent_review_template_form_fields" ADD CONSTRAINT "talent_review_template_form_fields_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_form_fields" ADD CONSTRAINT "talent_review_template_form_fields_tenant_id_step_form_id_talent_review_template_step_forms_tenant_id_id_fk" FOREIGN KEY ("tenant_id","step_form_id") REFERENCES "public"."talent_review_template_step_forms"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_form_fields" ADD CONSTRAINT "talent_review_template_form_fields_tenant_id_field_id_talent_review_fields_tenant_id_id_fk" FOREIGN KEY ("tenant_id","field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_result_module_refs" ADD CONSTRAINT "talent_review_template_result_module_refs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_result_module_refs" ADD CONSTRAINT "talent_review_template_result_module_refs_tenant_id_rule_id_talent_review_template_result_rules_tenant_id_id_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."talent_review_template_result_rules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_result_module_refs" ADD CONSTRAINT "talent_review_template_result_module_refs_tenant_id_module_id_talent_review_template_modules_tenant_id_id_fk" FOREIGN KEY ("tenant_id","module_id") REFERENCES "public"."talent_review_template_modules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_result_refs" ADD CONSTRAINT "talent_review_template_result_refs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_result_refs" ADD CONSTRAINT "talent_review_template_result_refs_tenant_id_rule_id_talent_review_template_result_rules_tenant_id_id_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."talent_review_template_result_rules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_result_refs" ADD CONSTRAINT "talent_review_template_result_refs_tenant_id_field_id_talent_review_fields_tenant_id_id_fk" FOREIGN KEY ("tenant_id","field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_result_rules" ADD CONSTRAINT "talent_review_template_result_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_result_rules" ADD CONSTRAINT "talent_review_template_result_rules_tenant_id_version_id_talent_review_template_versions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."talent_review_template_versions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_result_rules" ADD CONSTRAINT "talent_review_template_result_rules_tenant_id_target_field_id_talent_review_fields_tenant_id_id_fk" FOREIGN KEY ("tenant_id","target_field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_step_forms" ADD CONSTRAINT "talent_review_template_step_forms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_step_forms" ADD CONSTRAINT "talent_review_template_step_forms_tenant_id_step_id_talent_review_template_steps_tenant_id_id_fk" FOREIGN KEY ("tenant_id","step_id") REFERENCES "public"."talent_review_template_steps"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_step_forms" ADD CONSTRAINT "talent_review_template_step_forms_tenant_id_role_id_talent_review_roles_tenant_id_id_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."talent_review_roles"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_template_step_forms" ADD CONSTRAINT "talent_review_template_step_forms_tenant_id_form_id_talent_review_forms_tenant_id_id_fk" FOREIGN KEY ("tenant_id","form_id") REFERENCES "public"."talent_review_forms"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_template_step_forms');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_template_form_fields');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_template_result_rules');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_template_result_refs');
--> statement-breakpoint
-- 版本子表只追加，应用角色不可覆盖历史版本。
GRANT SELECT, INSERT, DELETE ON talent_review_template_step_forms, talent_review_template_form_fields, talent_review_template_result_rules, talent_review_template_result_refs TO app_user;

--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_template_result_module_refs');
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON talent_review_template_result_module_refs TO app_user;
