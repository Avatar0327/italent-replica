CREATE TABLE "retirement_identity_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retirement_identity_types_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "retirement_identity_types_code_nonempty" CHECK (btrim("retirement_identity_types"."code") <> ''),
	CONSTRAINT "retirement_identity_types_name_nonempty" CHECK (btrim("retirement_identity_types"."name") <> ''),
	CONSTRAINT "retirement_identity_types_revision_positive" CHECK ("retirement_identity_types"."revision" > 0),
	CONSTRAINT "retirement_identity_types_display_order" CHECK ("retirement_identity_types"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "retirement_rule_conditions" (
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"field_code" text NOT NULL,
	"operator" text NOT NULL,
	"values" text[] NOT NULL,
	CONSTRAINT "retirement_rule_conditions_pk" PRIMARY KEY("tenant_id","rule_id","seq"),
	CONSTRAINT "retirement_rule_conditions_slot" UNIQUE("tenant_id","rule_id","field_code"),
	CONSTRAINT "retirement_rule_conditions_seq" CHECK ("retirement_rule_conditions"."seq" BETWEEN 1 AND 4),
	CONSTRAINT "retirement_rule_conditions_field" CHECK ("retirement_rule_conditions"."field_code" IN ('gender', 'nationality', 'employType', 'identityType')),
	CONSTRAINT "retirement_rule_conditions_operator" CHECK ("retirement_rule_conditions"."operator" = 'in'),
	CONSTRAINT "retirement_rule_conditions_values" CHECK (cardinality("retirement_rule_conditions"."values") BETWEEN 1 AND 50)
);
--> statement-breakpoint
CREATE TABLE "retirement_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"rule_type" text NOT NULL,
	"name" text NOT NULL,
	"priority" integer NOT NULL,
	"sequence_no" integer NOT NULL,
	"org_ids" uuid[] NOT NULL,
	"include_subordinates" boolean DEFAULT true NOT NULL,
	"retirement_age_years" integer,
	"retirement_age_months" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retirement_rules_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "retirement_rules_sequence" UNIQUE("tenant_id","purpose","sequence_no"),
	CONSTRAINT "retirement_rules_purpose" CHECK ("retirement_rules"."purpose" IN ('expected_date')),
	CONSTRAINT "retirement_rules_rule_type" CHECK ("retirement_rules"."rule_type" IN ('fixed_age')),
	CONSTRAINT "retirement_rules_name" CHECK (btrim("retirement_rules"."name") <> '' AND char_length("retirement_rules"."name") <= 100),
	CONSTRAINT "retirement_rules_priority" CHECK ("retirement_rules"."priority" BETWEEN 0 AND 9999),
	CONSTRAINT "retirement_rules_sequence_positive" CHECK ("retirement_rules"."sequence_no" > 0),
	CONSTRAINT "retirement_rules_orgs" CHECK (cardinality("retirement_rules"."org_ids") BETWEEN 1 AND 50),
	CONSTRAINT "retirement_rules_age" CHECK ("retirement_rules"."purpose" <> 'expected_date' OR ("retirement_rules"."retirement_age_years" BETWEEN 30 AND 80
        AND "retirement_rules"."retirement_age_months" BETWEEN 0 AND 11)),
	CONSTRAINT "retirement_rules_revision_positive" CHECK ("retirement_rules"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "personnel_employee_versions" ADD COLUMN "expected_retirement_confirmed" boolean;--> statement-breakpoint
ALTER TABLE "personnel_employee_versions" ADD COLUMN "identity_type" text;--> statement-breakpoint
ALTER TABLE "personnel_employee_versions" ADD COLUMN "earliest_retirement_date" date;--> statement-breakpoint
ALTER TABLE "personnel_employee_versions" ADD COLUMN "latest_retirement_date" date;--> statement-breakpoint
ALTER TABLE "personnel_employee_versions" ADD COLUMN "flexible_range_confirmed" boolean;--> statement-breakpoint
ALTER TABLE "personnel_employee_versions" ADD COLUMN "original_expected_retirement_date" date;--> statement-breakpoint
ALTER TABLE "retirement_identity_types" ADD CONSTRAINT "retirement_identity_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_rule_conditions" ADD CONSTRAINT "retirement_rule_conditions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_rule_conditions" ADD CONSTRAINT "retirement_rule_conditions_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."retirement_rules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD CONSTRAINT "retirement_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retirement_identity_types_code" ON "retirement_identity_types" USING btree ("tenant_id",lower("code"));--> statement-breakpoint
-- R2 BE-5c1a：租户隔离与授权。规则可改的列逐列授权，删除保留审计快照；条件整份替换（先删后插）；
-- 个人身份字典只读（DEC-640③ 不提供新增 / 修改），标准项由 DEC-361 种子登记按租户补装，故只授 SELECT / INSERT
SELECT enable_tenant_isolation('retirement_rules');
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON retirement_rules TO app_user;
--> statement-breakpoint
GRANT UPDATE (name, priority, org_ids, include_subordinates, retirement_age_years, retirement_age_months, enabled,
  revision, updated_at) ON retirement_rules TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('retirement_rule_conditions');
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON retirement_rule_conditions TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('retirement_identity_types');
--> statement-breakpoint
GRANT SELECT, INSERT ON retirement_identity_types TO app_user;
--> statement-breakpoint
-- 退休三个租户配置项（两层配置，租户覆盖走既有 /api/tenant/settings/:key）：A-5 自动计算默认关，RT-R1 即将退休天数 30
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('retirement.auto_expected_date','false'::jsonb,'退休：自动计算预计退休日期（true 开启 / false 关闭）',true,1,now()),
  ('retirement.auto_flexible_range','false'::jsonb,'退休：自动计算弹性退休范围（true 开启 / false 关闭）',true,1,now()),
  ('retirement.upcoming_days','30'::jsonb,'退休：即将退休的天数范围（1～365 天）',true,1,now());
