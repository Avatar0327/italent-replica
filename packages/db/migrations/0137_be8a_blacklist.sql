CREATE TABLE "employment_blacklist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid,
	"name" text NOT NULL,
	"id_number" text,
	"mobile_phone" text,
	"email" text,
	"reason" text NOT NULL,
	"blacklist_date" date NOT NULL,
	"expiry_date" date,
	"note" text,
	"source" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_blacklist_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_blacklist_name" CHECK (btrim("employment_blacklist"."name") <> ''),
	CONSTRAINT "employment_blacklist_reason" CHECK ("employment_blacklist"."reason" IN ('major_violation', 'integrity', 'instability', 'resignation', 'other')),
	CONSTRAINT "employment_blacklist_source" CHECK ("employment_blacklist"."source" IN ('manual', 'auto_rule', 'import')),
	CONSTRAINT "employment_blacklist_status" CHECK (("employment_blacklist"."status" = 'active' AND "employment_blacklist"."removed_at" IS NULL)
        OR ("employment_blacklist"."status" = 'removed' AND "employment_blacklist"."removed_at" IS NOT NULL)),
	CONSTRAINT "employment_blacklist_expiry" CHECK ("employment_blacklist"."expiry_date" IS NULL OR "employment_blacklist"."expiry_date" >= "employment_blacklist"."blacklist_date"),
	CONSTRAINT "employment_blacklist_contact" CHECK ("employment_blacklist"."employee_id" IS NOT NULL OR "employment_blacklist"."id_number" IS NOT NULL OR "employment_blacklist"."mobile_phone" IS NOT NULL
        OR "employment_blacklist"."email" IS NOT NULL),
	CONSTRAINT "employment_blacklist_note" CHECK ("employment_blacklist"."note" IS NULL OR char_length("employment_blacklist"."note") <= 500),
	CONSTRAINT "employment_blacklist_revision_positive" CHECK ("employment_blacklist"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "employment_blacklist_rule_conditions" (
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"field" text NOT NULL,
	"operator" text NOT NULL,
	"value" integer NOT NULL,
	CONSTRAINT "employment_blacklist_rule_conditions_pk" PRIMARY KEY("tenant_id","rule_id","ordinal"),
	CONSTRAINT "employment_blacklist_rule_conditions_field" CHECK ("employment_blacklist_rule_conditions"."field" = 'exitCount'),
	CONSTRAINT "employment_blacklist_rule_conditions_operator" CHECK ("employment_blacklist_rule_conditions"."operator" = 'gte'),
	CONSTRAINT "employment_blacklist_rule_conditions_value" CHECK ("employment_blacklist_rule_conditions"."value" BETWEEN 1 AND 999)
);
--> statement-breakpoint
CREATE TABLE "employment_blacklist_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" integer NOT NULL,
	"org_ids" uuid[] NOT NULL,
	"description" text,
	"term" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_blacklist_rules_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_blacklist_rules_name" CHECK (btrim("employment_blacklist_rules"."name") <> ''),
	CONSTRAINT "employment_blacklist_rules_priority" CHECK ("employment_blacklist_rules"."priority" BETWEEN 0 AND 9999),
	CONSTRAINT "employment_blacklist_rules_orgs" CHECK (cardinality("employment_blacklist_rules"."org_ids") BETWEEN 1 AND 50),
	CONSTRAINT "employment_blacklist_rules_term" CHECK ("employment_blacklist_rules"."term" IN ('permanent', 'exit_month')),
	CONSTRAINT "employment_blacklist_rules_reason" CHECK ("employment_blacklist_rules"."reason" IN ('major_violation', 'integrity', 'instability', 'resignation', 'other')),
	CONSTRAINT "employment_blacklist_rules_text" CHECK (coalesce(char_length("employment_blacklist_rules"."description"), 0) <= 500 AND coalesce(char_length("employment_blacklist_rules"."note"), 0) <= 500),
	CONSTRAINT "employment_blacklist_rules_revision_positive" CHECK ("employment_blacklist_rules"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "employment_blacklist" ADD CONSTRAINT "employment_blacklist_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_blacklist" ADD CONSTRAINT "employment_blacklist_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_blacklist_rule_conditions" ADD CONSTRAINT "employment_blacklist_rule_conditions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_blacklist_rule_conditions" ADD CONSTRAINT "employment_blacklist_rule_conditions_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."employment_blacklist_rules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_blacklist_rules" ADD CONSTRAINT "employment_blacklist_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employment_blacklist_active_employee" ON "employment_blacklist" USING btree ("tenant_id","employee_id") WHERE "employment_blacklist"."status" = 'active' AND "employment_blacklist"."employee_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employment_blacklist_active_id_number" ON "employment_blacklist" USING btree ("tenant_id",lower(btrim("id_number"))) WHERE "employment_blacklist"."status" = 'active' AND "employment_blacklist"."id_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "employment_blacklist_list" ON "employment_blacklist" USING btree ("tenant_id","status","blacklist_date");--> statement-breakpoint
-- R2 BE-8a（B68）：租户隔离与授权。黑名单可改的列逐列授权（身份快照、加黑日期、来源创建后不变）；删除保留审计快照
SELECT enable_tenant_isolation('employment_blacklist');
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON employment_blacklist TO app_user;
--> statement-breakpoint
GRANT UPDATE (reason, expiry_date, note, status, removed_at, removed_by, revision, updated_at)
  ON employment_blacklist TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_blacklist_rules');
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON employment_blacklist_rules TO app_user;
--> statement-breakpoint
GRANT UPDATE (name, priority, org_ids, description, term, reason, note, revision, updated_at)
  ON employment_blacklist_rules TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_blacklist_rule_conditions');
--> statement-breakpoint
-- 条件随规则整组替换（删后重插），不原地改
GRANT SELECT, INSERT, DELETE ON employment_blacklist_rule_conditions TO app_user;
--> statement-breakpoint
-- 离职后自动加入黑名单总开关，两层配置（租户覆盖走既有 /api/tenant/settings/:key），系统值关闭
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('exit.auto_blacklist_enabled','false'::jsonb,'离职：离职后自动加入黑名单（true 开启 / false 关闭）',true,1,now());
