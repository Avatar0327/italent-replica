CREATE TABLE "talent_review_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_categories_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_categories_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "talent_review_categories_rev" CHECK ("talent_review_categories"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "talent_review_field_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "talent_review_field_options_value" UNIQUE("tenant_id","field_id","value")
);
--> statement-breakpoint
CREATE TABLE "talent_review_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"field_group" text NOT NULL,
	"preset" boolean DEFAULT false NOT NULL,
	"system_written" boolean DEFAULT false NOT NULL,
	"pair_role" text,
	"pair_field_id" uuid,
	"precision" smallint,
	"sort_no" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_fields_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_fields_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "talent_review_fields_pair" UNIQUE("tenant_id","pair_field_id"),
	CONSTRAINT "talent_review_fields_code_format" CHECK ("talent_review_fields"."code" ~ '^[A-Za-z][A-Za-z0-9_]{0,49}$'),
	CONSTRAINT "talent_review_fields_kind" CHECK ("talent_review_fields"."kind" IN ('number','text','option','multi_option','date','boolean')),
	CONSTRAINT "talent_review_fields_group" CHECK ("talent_review_fields"."field_group" IN ('result','position','basic','evaluation','calibration')),
	CONSTRAINT "talent_review_fields_pair_role" CHECK ("talent_review_fields"."pair_role" IS NULL OR "talent_review_fields"."pair_role" IN ('before','after')),
	CONSTRAINT "talent_review_fields_pair_target" CHECK ("talent_review_fields"."pair_field_id" IS NULL OR "talent_review_fields"."pair_role" IS NOT NULL),
	CONSTRAINT "talent_review_fields_precision_kind" CHECK (("talent_review_fields"."kind" = 'number') = ("talent_review_fields"."precision" IS NOT NULL)),
	CONSTRAINT "talent_review_fields_precision_range" CHECK ("talent_review_fields"."precision" BETWEEN 0 AND 4),
	CONSTRAINT "talent_review_fields_rev" CHECK ("talent_review_fields"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "talent_review_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"resolver" text NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_roles_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_roles_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "talent_review_roles_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "talent_review_roles_resolver" CHECK ("talent_review_roles"."resolver" IN ('direct_manager','indirect_manager','self','designated')),
	CONSTRAINT "talent_review_roles_rev" CHECK ("talent_review_roles"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "talent_review_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"allow_secondary_key_position_nomination" boolean DEFAULT false NOT NULL,
	"self_result_visible" boolean DEFAULT false NOT NULL,
	"done_hide_succession" boolean DEFAULT false NOT NULL,
	"system_principal_user_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_settings_tenant" UNIQUE("tenant_id"),
	CONSTRAINT "talent_review_settings_rev" CHECK ("talent_review_settings"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "talent_review_categories" ADD CONSTRAINT "talent_review_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_field_options" ADD CONSTRAINT "talent_review_field_options_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_field_options" ADD CONSTRAINT "talent_review_field_options_field_fk" FOREIGN KEY ("tenant_id","field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_fields" ADD CONSTRAINT "talent_review_fields_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_fields" ADD CONSTRAINT "talent_review_fields_pair_fk" FOREIGN KEY ("tenant_id","pair_field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_roles" ADD CONSTRAINT "talent_review_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_settings" ADD CONSTRAINT "talent_review_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_settings" ADD CONSTRAINT "talent_review_settings_system_principal_user_id_users_id_fk" FOREIGN KEY ("system_principal_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- R3-T04 PR-B1：配置对象统一租户隔离（AGENTS §2；guard-rls）。删除由服务层先询问引用守卫，应用角色需要 DELETE。
SELECT enable_tenant_isolation('talent_review_settings');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_categories');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_roles');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_fields');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_field_options');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_review_settings, talent_review_categories, talent_review_roles, talent_review_fields, talent_review_field_options TO app_user;
