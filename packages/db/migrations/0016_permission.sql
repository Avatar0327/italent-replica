-- R1-T01 权限模型表（pnpm db:generate 生成）。main 的 0015_employment_outbox_payload_version 是手写迁移且未更新快照，
-- 生成时会重复带出 employment_outbox 的 3 条变更；它们已由 0015 执行，故从本文件删去（快照 0016 已含其最终状态）。
CREATE TABLE "license_pools" (
	"tenant_id" uuid NOT NULL,
	"license_type" text NOT NULL,
	"quota" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "license_pools_tenant_id_license_type_pk" PRIMARY KEY("tenant_id","license_type"),
	CONSTRAINT "license_pools_quota_non_negative" CHECK ("license_pools"."quota" >= 0)
);
--> statement-breakpoint
CREATE TABLE "license_seats" (
	"tenant_id" uuid NOT NULL,
	"license_type" text NOT NULL,
	"user_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "license_seats_tenant_id_license_type_user_id_pk" PRIMARY KEY("tenant_id","license_type","user_id")
);
--> statement-breakpoint
CREATE TABLE "permission_admin_grantable_profiles" (
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	CONSTRAINT "permission_admin_grantable_profiles_admin_id_profile_id_pk" PRIMARY KEY("admin_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "permission_admin_grantable_roles" (
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "permission_admin_grantable_roles_admin_id_role_pk" PRIMARY KEY("admin_id","role"),
	CONSTRAINT "permission_admin_grantable_roles_role_valid" CHECK ("permission_admin_grantable_roles"."role" IN ('tenant_admin', 'system_admin', 'employee_admin', 'user_admin', 'permission_admin', 'matrix_admin', 'audit_admin', 'billing_admin'))
);
--> statement-breakpoint
CREATE TABLE "permission_admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_admins_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "permission_admins_role_valid" CHECK ("permission_admins"."role" IN ('tenant_admin', 'system_admin', 'employee_admin', 'user_admin', 'permission_admin', 'matrix_admin', 'audit_admin', 'billing_admin')),
	CONSTRAINT "permission_admins_status_valid" CHECK ("permission_admins"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "permission_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"granted_by" uuid,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_grants_source_valid" CHECK ("permission_grants"."source" IN ('manual', 'auto')),
	CONSTRAINT "permission_grants_status_valid" CHECK ("permission_grants"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "permission_profile_apps" (
	"tenant_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"app_code" text NOT NULL,
	CONSTRAINT "permission_profile_apps_profile_id_app_code_pk" PRIMARY KEY("profile_id","app_code")
);
--> statement-breakpoint
CREATE TABLE "permission_profile_buttons" (
	"tenant_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"object_code" text NOT NULL,
	"button_code" text NOT NULL,
	"level" text NOT NULL,
	CONSTRAINT "permission_profile_buttons_profile_id_object_code_button_code_level_pk" PRIMARY KEY("profile_id","object_code","button_code","level"),
	CONSTRAINT "permission_profile_buttons_level_valid" CHECK ("permission_profile_buttons"."level" IN ('list', 'list_row', 'detail', 'app_page'))
);
--> statement-breakpoint
CREATE TABLE "permission_profile_fields" (
	"tenant_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"object_code" text NOT NULL,
	"field_code" text NOT NULL,
	"can_view" boolean NOT NULL,
	"can_edit" boolean NOT NULL,
	CONSTRAINT "permission_profile_fields_profile_id_object_code_field_code_pk" PRIMARY KEY("profile_id","object_code","field_code")
);
--> statement-breakpoint
CREATE TABLE "permission_profile_objects" (
	"tenant_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"object_code" text NOT NULL,
	"can_create" boolean NOT NULL,
	"can_update" boolean NOT NULL,
	"can_delete" boolean NOT NULL,
	CONSTRAINT "permission_profile_objects_tenant_id_profile_id_object_code_pk" PRIMARY KEY("tenant_id","profile_id","object_code")
);
--> statement-breakpoint
CREATE TABLE "permission_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'custom' NOT NULL,
	"license_type" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_profiles_tenant_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "permission_profiles_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "permission_profiles_source_valid" CHECK ("permission_profiles"."source" IN ('standard', 'custom'))
);
--> statement-breakpoint
ALTER TABLE "license_pools" ADD CONSTRAINT "license_pools_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_seats" ADD CONSTRAINT "license_seats_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_seats" ADD CONSTRAINT "license_seats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_seats" ADD CONSTRAINT "license_seats_grant_id_permission_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."permission_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_seats" ADD CONSTRAINT "license_seats_pool" FOREIGN KEY ("tenant_id","license_type") REFERENCES "public"."license_pools"("tenant_id","license_type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_admin_grantable_profiles" ADD CONSTRAINT "permission_admin_grantable_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_admin_grantable_profiles" ADD CONSTRAINT "permission_admin_grantable_profiles_admin" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."permission_admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_admin_grantable_profiles" ADD CONSTRAINT "permission_admin_grantable_profiles_profile" FOREIGN KEY ("tenant_id","profile_id") REFERENCES "public"."permission_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_admin_grantable_roles" ADD CONSTRAINT "permission_admin_grantable_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_admin_grantable_roles" ADD CONSTRAINT "permission_admin_grantable_roles_admin" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."permission_admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_admins" ADD CONSTRAINT "permission_admins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_admins" ADD CONSTRAINT "permission_admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_admins" ADD CONSTRAINT "permission_admins_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_profile" FOREIGN KEY ("tenant_id","profile_id") REFERENCES "public"."permission_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_profile_apps" ADD CONSTRAINT "permission_profile_apps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_profile_apps" ADD CONSTRAINT "permission_profile_apps_profile" FOREIGN KEY ("tenant_id","profile_id") REFERENCES "public"."permission_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_profile_buttons" ADD CONSTRAINT "permission_profile_buttons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_profile_buttons" ADD CONSTRAINT "permission_profile_buttons_object" FOREIGN KEY ("tenant_id","profile_id","object_code") REFERENCES "public"."permission_profile_objects"("tenant_id","profile_id","object_code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_profile_fields" ADD CONSTRAINT "permission_profile_fields_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_profile_fields" ADD CONSTRAINT "permission_profile_fields_object" FOREIGN KEY ("tenant_id","profile_id","object_code") REFERENCES "public"."permission_profile_objects"("tenant_id","profile_id","object_code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_profile_objects" ADD CONSTRAINT "permission_profile_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_profile_objects" ADD CONSTRAINT "permission_profile_objects_profile" FOREIGN KEY ("tenant_id","profile_id") REFERENCES "public"."permission_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_profiles" ADD CONSTRAINT "permission_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_profiles" ADD CONSTRAINT "permission_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "permission_admins_active_user_role" ON "permission_admins" USING btree ("tenant_id","user_id","role") WHERE "permission_admins"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "permission_grants_active_user_profile" ON "permission_grants" USING btree ("tenant_id","user_id","profile_id") WHERE "permission_grants"."status" = 'active';
