CREATE TABLE "onboarding_collection_fields" (
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"object_code" text NOT NULL,
	"field_code" text NOT NULL,
	"group_name" text NOT NULL,
	"position" integer NOT NULL,
	"required" boolean NOT NULL,
	"editable" boolean NOT NULL,
	CONSTRAINT "onboarding_collection_fields_tenant_id_template_id_object_code_field_code_pk" PRIMARY KEY("tenant_id","template_id","object_code","field_code"),
	CONSTRAINT "onboarding_collection_field_position" UNIQUE("tenant_id","template_id","position"),
	CONSTRAINT "onboarding_collection_field_position_nonnegative" CHECK ("onboarding_collection_fields"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "onboarding_collection_required_subsets" (
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"subset_code" text NOT NULL,
	CONSTRAINT "onboarding_collection_required_subsets_tenant_id_rule_id_subset_code_pk" PRIMARY KEY("tenant_id","rule_id","subset_code")
);
--> statement-breakpoint
CREATE TABLE "onboarding_collection_rules" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"conditions" jsonb NOT NULL,
	"verification_mode" text NOT NULL,
	"requires_approval" boolean NOT NULL,
	"remind_days_before" integer,
	CONSTRAINT "onboarding_collection_rule_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_collection_rules_revision_positive" CHECK ("onboarding_collection_rules"."revision" > 0),
	CONSTRAINT "onboarding_collection_rule_archived" CHECK (NOT "onboarding_collection_rules"."archived" OR NOT "onboarding_collection_rules"."enabled"),
	CONSTRAINT "onboarding_collection_rule_priority" CHECK ("onboarding_collection_rules"."priority" >= 0),
	CONSTRAINT "onboarding_collection_rule_remind_days" CHECK ("onboarding_collection_rules"."remind_days_before" BETWEEN 1 AND 365),
	CONSTRAINT "onboarding_collection_rule_verify" CHECK ("onboarding_collection_rules"."verification_mode" IN ('independent_channel','phone_otp'))
);
--> statement-breakpoint
CREATE TABLE "onboarding_collection_scope_orgs" (
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	CONSTRAINT "onboarding_collection_scope_orgs_tenant_id_rule_id_org_id_pk" PRIMARY KEY("tenant_id","rule_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "onboarding_collection_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "onboarding_collection_settings_revision_positive" CHECK ("onboarding_collection_settings"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "onboarding_collection_templates" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"notice_title" text NOT NULL,
	"notice_body" text NOT NULL,
	CONSTRAINT "onboarding_collection_template_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_collection_templates_revision_positive" CHECK ("onboarding_collection_templates"."revision" > 0),
	CONSTRAINT "onboarding_collection_template_archived" CHECK (NOT "onboarding_collection_templates"."archived" OR NOT "onboarding_collection_templates"."enabled")
);
--> statement-breakpoint
ALTER TABLE "onboarding_collection_fields" ADD CONSTRAINT "onboarding_collection_fields_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_fields" ADD CONSTRAINT "onboarding_collection_field_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."onboarding_collection_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_required_subsets" ADD CONSTRAINT "onboarding_collection_required_subsets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_required_subsets" ADD CONSTRAINT "onboarding_collection_required_subset_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."onboarding_collection_rules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_rules" ADD CONSTRAINT "onboarding_collection_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_rules" ADD CONSTRAINT "onboarding_collection_rules_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_rules" ADD CONSTRAINT "onboarding_collection_rules_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_rules" ADD CONSTRAINT "onboarding_collection_rule_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."onboarding_collection_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_scope_orgs" ADD CONSTRAINT "onboarding_collection_scope_orgs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_scope_orgs" ADD CONSTRAINT "onboarding_collection_scope_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."onboarding_collection_rules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_scope_orgs" ADD CONSTRAINT "onboarding_collection_scope_org_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_settings" ADD CONSTRAINT "onboarding_collection_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_settings" ADD CONSTRAINT "onboarding_collection_settings_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_settings" ADD CONSTRAINT "onboarding_collection_settings_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_templates" ADD CONSTRAINT "onboarding_collection_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_templates" ADD CONSTRAINT "onboarding_collection_templates_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_collection_templates" ADD CONSTRAINT "onboarding_collection_templates_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_collection_rule_template" ON "onboarding_collection_rules" USING btree ("tenant_id","template_id");--> statement-breakpoint
CREATE INDEX "onboarding_collection_rule_match" ON "onboarding_collection_rules" USING btree ("tenant_id","archived","enabled","priority","id");--> statement-breakpoint
CREATE INDEX "onboarding_collection_scope_org" ON "onboarding_collection_scope_orgs" USING btree ("tenant_id","org_id","rule_id");--> statement-breakpoint
CREATE INDEX "onboarding_collection_template_list" ON "onboarding_collection_templates" USING btree ("tenant_id","archived","id");
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_collection_templates');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_collection_fields');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_collection_rules');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_collection_scope_orgs');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_collection_required_subsets');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_collection_settings');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON onboarding_collection_templates, onboarding_collection_rules,
  onboarding_collection_settings TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON onboarding_collection_fields, onboarding_collection_scope_orgs,
  onboarding_collection_required_subsets TO app_user;
