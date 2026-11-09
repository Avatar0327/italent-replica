CREATE TABLE "transfer_linkage_esign_templates" (
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"template_id" uuid NOT NULL,
	CONSTRAINT "transfer_linkage_esign_templates_tenant_id_version_id_seq_pk" PRIMARY KEY("tenant_id","version_id","seq"),
	CONSTRAINT "transfer_linkage_esign_templates_seq" CHECK ("transfer_linkage_esign_templates"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "esign_scene_settings" (
	"tenant_id" uuid NOT NULL,
	"scene" text NOT NULL,
	"validity_days" integer DEFAULT 2 NOT NULL,
	"remind_before_expiry" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "esign_scene_settings_tenant_id_scene_pk" PRIMARY KEY("tenant_id","scene"),
	CONSTRAINT "esign_scene_settings_scene" CHECK ("esign_scene_settings"."scene" IN ('transfer')),
	CONSTRAINT "esign_scene_settings_validity" CHECK ("esign_scene_settings"."validity_days" BETWEEN 2 AND 30),
	CONSTRAINT "esign_scene_settings_revision" CHECK ("esign_scene_settings"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "esign_task_files" (
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"template_id" uuid NOT NULL,
	"template_name" text NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "esign_task_files_tenant_id_task_id_seq_pk" PRIMARY KEY("tenant_id","task_id","seq"),
	CONSTRAINT "esign_task_files_seq" CHECK ("esign_task_files"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "esign_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scene" text NOT NULL,
	"business_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"owner_department_id" uuid,
	"initiator_user_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"status" text NOT NULL,
	"current_node" text,
	"employee_signer_user_id" uuid,
	"employee_signed_at" timestamp with time zone,
	"enterprise_signed_at" timestamp with time zone,
	"validity_days" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"remind_before_expiry" boolean DEFAULT false NOT NULL,
	"expiry_reminded_at" timestamp with time zone,
	"initiated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_cause" text,
	"expired_at" timestamp with time zone,
	"failure_reason" text,
	"failure_detail" text,
	"provider" text DEFAULT 'simulated' NOT NULL,
	"provider_ref" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "esign_tasks_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "esign_tasks_scene" CHECK ("esign_tasks"."scene" IN ('transfer')),
	CONSTRAINT "esign_tasks_origin" CHECK ("esign_tasks"."origin" IN ('activation', 'manual')),
	CONSTRAINT "esign_tasks_status" CHECK ("esign_tasks"."status" IN ('signing', 'completed', 'revoked', 'expired', 'failed')),
	CONSTRAINT "esign_tasks_node" CHECK ("esign_tasks"."current_node" IS NULL OR "esign_tasks"."current_node" IN ('employee', 'enterprise')),
	CONSTRAINT "esign_tasks_terminal_node" CHECK (("esign_tasks"."status" = 'signing') = ("esign_tasks"."current_node" IS NOT NULL)),
	CONSTRAINT "esign_tasks_failure" CHECK (("esign_tasks"."status" = 'failed') = ("esign_tasks"."failure_reason" IS NOT NULL)),
	CONSTRAINT "esign_tasks_revoke_cause" CHECK ("esign_tasks"."revoke_cause" IS NULL OR "esign_tasks"."revoke_cause" IN ('manual', 'business_deleted')),
	CONSTRAINT "esign_tasks_validity" CHECK ("esign_tasks"."validity_days" BETWEEN 2 AND 30),
	CONSTRAINT "esign_tasks_revision" CHECK ("esign_tasks"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "esign_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'enabled' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "esign_templates_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "esign_templates_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "esign_templates_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "esign_templates_code_nonempty" CHECK (btrim("esign_templates"."code") <> ''),
	CONSTRAINT "esign_templates_name_length" CHECK (char_length("esign_templates"."name") BETWEEN 1 AND 100 AND btrim("esign_templates"."name") <> ''),
	CONSTRAINT "esign_templates_body_length" CHECK (char_length("esign_templates"."body") <= 20000),
	CONSTRAINT "esign_templates_status" CHECK ("esign_templates"."status" IN ('enabled', 'disabled')),
	CONSTRAINT "esign_templates_revision" CHECK ("esign_templates"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "transfer_linkage_versions" ADD COLUMN "esign_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transfer_linkage_esign_templates" ADD CONSTRAINT "transfer_linkage_esign_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_linkage_esign_templates" ADD CONSTRAINT "transfer_linkage_esign_templates_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."transfer_linkage_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_linkage_esign_templates" ADD CONSTRAINT "transfer_linkage_esign_templates_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."esign_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_scene_settings" ADD CONSTRAINT "esign_scene_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_scene_settings" ADD CONSTRAINT "esign_scene_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_task_files" ADD CONSTRAINT "esign_task_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_task_files" ADD CONSTRAINT "esign_task_files_task_fk" FOREIGN KEY ("tenant_id","task_id") REFERENCES "public"."esign_tasks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_task_files" ADD CONSTRAINT "esign_task_files_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."esign_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD CONSTRAINT "esign_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD CONSTRAINT "esign_tasks_initiator_user_id_users_id_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD CONSTRAINT "esign_tasks_employee_signer_user_id_users_id_fk" FOREIGN KEY ("employee_signer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD CONSTRAINT "esign_tasks_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD CONSTRAINT "esign_tasks_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD CONSTRAINT "esign_tasks_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD CONSTRAINT "esign_tasks_department_fk" FOREIGN KEY ("tenant_id","owner_department_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_templates" ADD CONSTRAINT "esign_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_templates" ADD CONSTRAINT "esign_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "esign_tasks_business" ON "esign_tasks" USING btree ("tenant_id","business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "esign_tasks_one_signing" ON "esign_tasks" USING btree ("tenant_id","business_id") WHERE "esign_tasks"."status" = 'signing';--> statement-breakpoint
CREATE INDEX "esign_templates_options" ON "esign_templates" USING btree ("tenant_id","status","sort_order","name");--> statement-breakpoint
-- 行级安全（硬规则：租户隔离）：ENABLE + FORCE，app_user / app_owner 都受策略约束；本片没有删除路径，故只授 SELECT / INSERT / UPDATE。
SELECT enable_tenant_isolation('esign_templates');
--> statement-breakpoint
SELECT enable_tenant_isolation('esign_scene_settings');
--> statement-breakpoint
SELECT enable_tenant_isolation('esign_tasks');
--> statement-breakpoint
SELECT enable_tenant_isolation('esign_task_files');
--> statement-breakpoint
SELECT enable_tenant_isolation('transfer_linkage_esign_templates');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON esign_templates TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON esign_scene_settings TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON esign_tasks TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON esign_task_files TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON transfer_linkage_esign_templates TO app_user;
--> statement-breakpoint
-- 联动版本的所选模板与 transfer_linkage_duties 同型：一次保存一版，不原地改（禁止 UPDATE / DELETE / TRUNCATE）。
CREATE TRIGGER transfer_linkage_esign_templates_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON transfer_linkage_esign_templates FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
