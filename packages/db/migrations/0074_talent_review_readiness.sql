CREATE TABLE "talent_readiness_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_readiness_levels_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_readiness_levels_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "talent_readiness_levels_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "talent_readiness_levels_color" CHECK ("talent_readiness_levels"."color" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "talent_readiness_levels_revision" CHECK ("talent_readiness_levels"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "approval_instances" DROP CONSTRAINT "approval_instances_business_type";--> statement-breakpoint
ALTER TABLE "talent_readiness_levels" ADD CONSTRAINT "talent_readiness_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_business_type" CHECK ("approval_instances"."business_type" IN ('employment','personnel_change','contract','idp','talent_review'));--> statement-breakpoint
-- R3-T04 PR-A：准备度共享字典统一租户隔离（AGENTS §2；guard-rls）。删除由服务层先询问引用守卫，应用角色需要 DELETE。
SELECT enable_tenant_isolation('talent_readiness_levels');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_readiness_levels TO app_user;
