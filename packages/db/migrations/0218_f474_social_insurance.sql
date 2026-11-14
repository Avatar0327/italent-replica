CREATE TABLE "social_insurance_archive_versions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"effective_date" date NOT NULL,
	"planned_effective_date" date NOT NULL,
	"operation_seq" bigint NOT NULL,
	"region_code" text,
	"plan_id" uuid,
	"company_id" uuid,
	"source" text NOT NULL,
	"source_business_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_insurance_archive_versions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "social_insurance_archive_versions_number" UNIQUE("tenant_id","employee_id","version_no"),
	CONSTRAINT "social_insurance_archive_versions_source" UNIQUE("tenant_id","source","source_business_id"),
	CONSTRAINT "social_insurance_archive_versions_number_positive" CHECK ("social_insurance_archive_versions"."version_no" > 0),
	CONSTRAINT "social_insurance_archive_versions_source_check" CHECK ("social_insurance_archive_versions"."source" IN ('transfer'))
);
--> statement-breakpoint
CREATE TABLE "social_insurance_plan_versions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"name" text NOT NULL,
	"region_code" text NOT NULL,
	"effective_month" date NOT NULL,
	"stop_month" date,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "social_insurance_plan_versions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "social_insurance_plan_versions_month" UNIQUE("tenant_id","plan_id","effective_month"),
	CONSTRAINT "social_insurance_plan_versions_month_start" CHECK (extract(day from "social_insurance_plan_versions"."effective_month") = 1),
	CONSTRAINT "social_insurance_plan_versions_stop_after" CHECK ("social_insurance_plan_versions"."stop_month" IS NULL OR ("social_insurance_plan_versions"."stop_month" > "social_insurance_plan_versions"."effective_month" AND extract(day from "social_insurance_plan_versions"."stop_month") = 1)),
	CONSTRAINT "social_insurance_plan_versions_revision_positive" CHECK ("social_insurance_plan_versions"."revision" > 0),
	CONSTRAINT "social_insurance_plan_versions_name_nonempty" CHECK (btrim("social_insurance_plan_versions"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "social_insurance_plans" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_insurance_plans_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "social_insurance_plans_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "social_insurance_plans_code_nonempty" CHECK (btrim("social_insurance_plans"."code") <> '')
);
--> statement-breakpoint
ALTER TABLE "transfer_linkage_versions" ADD COLUMN "adjusted_insurance_region_code" text;--> statement-breakpoint
ALTER TABLE "transfer_linkage_versions" ADD COLUMN "adjusted_insurance_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "transfer_linkage_versions" ADD COLUMN "adjusted_insurance_company_id" uuid;--> statement-breakpoint
ALTER TABLE "social_insurance_archive_versions" ADD CONSTRAINT "social_insurance_archive_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_insurance_archive_versions" ADD CONSTRAINT "social_insurance_archive_versions_region_code_admin_regions_code_fk" FOREIGN KEY ("region_code") REFERENCES "public"."admin_regions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_insurance_archive_versions" ADD CONSTRAINT "social_insurance_archive_versions_business_fk" FOREIGN KEY ("tenant_id","source_business_id") REFERENCES "public"."employment_business_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_insurance_archive_versions" ADD CONSTRAINT "social_insurance_archive_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_insurance_archive_versions" ADD CONSTRAINT "social_insurance_archive_versions_plan_fk" FOREIGN KEY ("tenant_id","plan_id") REFERENCES "public"."social_insurance_plans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_insurance_archive_versions" ADD CONSTRAINT "social_insurance_archive_versions_company_fk" FOREIGN KEY ("tenant_id","company_id") REFERENCES "public"."contract_companies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_insurance_plan_versions" ADD CONSTRAINT "social_insurance_plan_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_insurance_plan_versions" ADD CONSTRAINT "social_insurance_plan_versions_region_code_admin_regions_code_fk" FOREIGN KEY ("region_code") REFERENCES "public"."admin_regions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_insurance_plan_versions" ADD CONSTRAINT "social_insurance_plan_versions_plan_fk" FOREIGN KEY ("tenant_id","plan_id") REFERENCES "public"."social_insurance_plans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_insurance_plans" ADD CONSTRAINT "social_insurance_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_linkage_versions" ADD CONSTRAINT "transfer_linkage_versions_adjusted_insurance_region_code_admin_regions_code_fk" FOREIGN KEY ("adjusted_insurance_region_code") REFERENCES "public"."admin_regions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_linkage_versions" ADD CONSTRAINT "transfer_linkage_versions_insurance_plan_fk" FOREIGN KEY ("tenant_id","adjusted_insurance_plan_id") REFERENCES "public"."social_insurance_plans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_linkage_versions" ADD CONSTRAINT "transfer_linkage_versions_insurance_company_fk" FOREIGN KEY ("tenant_id","adjusted_insurance_company_id") REFERENCES "public"."contract_companies"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- 手写 1) 方案版本区间排他（设计 F-474-8b §3.2；btree_gist 见 0001，写法同 0081）：同一方案 [生效月, 停用月) 不得重叠，
--    停用月为空 = 长期有效；首尾相接合法。同月重复先被 UNIQUE 挡（23505），其余重叠由本约束兜底（23P01）。
ALTER TABLE social_insurance_plan_versions ADD CONSTRAINT social_insurance_plan_versions_no_overlap EXCLUDE USING gist (
  tenant_id WITH =,
  plan_id WITH =,
  daterange(effective_month, stop_month, '[)') WITH &&
);
--> statement-breakpoint
-- 手写 2) 租户隔离（FORCE RLS，策略 tenant_isolation）
SELECT enable_tenant_isolation('social_insurance_plans');
--> statement-breakpoint
SELECT enable_tenant_isolation('social_insurance_plan_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('social_insurance_archive_versions');
--> statement-breakpoint
-- 手写 3) app_user 最小授权：方案 / 方案版本是主数据，运行时只读（种子 / 导入脚本以属主身份写，需要时由 8c-2b 另行授权）；
--    档案是不可变版本链，运行时只追加，不得改、不得删、不得清表（TRUNCATE 不授）。
GRANT SELECT ON social_insurance_plans TO app_user;
--> statement-breakpoint
GRANT SELECT ON social_insurance_plan_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON social_insurance_archive_versions TO app_user;
