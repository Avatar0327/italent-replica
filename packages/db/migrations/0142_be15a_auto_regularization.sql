CREATE TABLE "employment_auto_regularization_daily_runs" (
	"tenant_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_auto_regularization_daily_runs_pk" PRIMARY KEY("tenant_id","business_date")
);
--> statement-breakpoint
CREATE TABLE "employment_auto_regularization_launches" (
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"anchor_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"state" text NOT NULL,
	"business_id" uuid,
	"initiator_user_id" uuid,
	"system_proxy" boolean DEFAULT true NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_reason" text,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_auto_regularization_launches_pk" PRIMARY KEY("tenant_id","rule_id","anchor_id"),
	CONSTRAINT "employment_auto_regularization_launches_state" CHECK ("employment_auto_regularization_launches"."state" IN ('launched', 'failed')),
	CONSTRAINT "employment_auto_regularization_launches_outcome" CHECK (("employment_auto_regularization_launches"."state" = 'launched') = ("employment_auto_regularization_launches"."business_id" IS NOT NULL)),
	CONSTRAINT "employment_auto_regularization_launches_attempts" CHECK ("employment_auto_regularization_launches"."attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "employment_auto_regularization_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" integer NOT NULL,
	"sequence_no" integer NOT NULL,
	"org_ids" uuid[] NOT NULL,
	"include_subordinates" boolean DEFAULT true NOT NULL,
	"mode" text NOT NULL,
	"days_before" integer NOT NULL,
	"initiator_type" text NOT NULL,
	"probation_result" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"operator_user_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_auto_regularization_rules_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_auto_regularization_rules_sequence" UNIQUE("tenant_id","sequence_no"),
	CONSTRAINT "employment_auto_regularization_rules_name" CHECK (btrim("employment_auto_regularization_rules"."name") <> '' AND char_length("employment_auto_regularization_rules"."name") <= 100),
	CONSTRAINT "employment_auto_regularization_rules_priority" CHECK ("employment_auto_regularization_rules"."priority" BETWEEN 0 AND 9999),
	CONSTRAINT "employment_auto_regularization_rules_sequence_positive" CHECK ("employment_auto_regularization_rules"."sequence_no" > 0),
	CONSTRAINT "employment_auto_regularization_rules_orgs" CHECK (cardinality("employment_auto_regularization_rules"."org_ids") BETWEEN 1 AND 50),
	CONSTRAINT "employment_auto_regularization_rules_mode" CHECK ("employment_auto_regularization_rules"."mode" IN ('direct', 'application')),
	CONSTRAINT "employment_auto_regularization_rules_days" CHECK ("employment_auto_regularization_rules"."days_before" BETWEEN 0 AND 999),
	CONSTRAINT "employment_auto_regularization_rules_initiator" CHECK ("employment_auto_regularization_rules"."initiator_type" IN ('rule_operator', 'department_hrbp', 'department_head')),
	CONSTRAINT "employment_auto_regularization_rules_revision_positive" CHECK ("employment_auto_regularization_rules"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "employment_auto_regularization_daily_runs" ADD CONSTRAINT "employment_auto_regularization_daily_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_auto_regularization_launches" ADD CONSTRAINT "employment_auto_regularization_launches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_auto_regularization_launches" ADD CONSTRAINT "employment_auto_regularization_launches_anchor_fk" FOREIGN KEY ("tenant_id","employee_id","anchor_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_auto_regularization_launches" ADD CONSTRAINT "employment_auto_regularization_launches_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_auto_regularization_rules" ADD CONSTRAINT "employment_auto_regularization_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- R2 BE-15a（B57）：租户隔离与授权。规则可改的列逐列授权，删除保留审计快照；发起台账只更新 failed 行（launched 后不再改，代码里带条件）
SELECT enable_tenant_isolation('employment_auto_regularization_rules');
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON employment_auto_regularization_rules TO app_user;
--> statement-breakpoint
GRANT UPDATE (name, priority, org_ids, include_subordinates, mode, days_before, initiator_type, probation_result,
  enabled, operator_user_id, revision, updated_at) ON employment_auto_regularization_rules TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_auto_regularization_launches');
--> statement-breakpoint
GRANT SELECT, INSERT ON employment_auto_regularization_launches TO app_user;
--> statement-breakpoint
GRANT UPDATE (state, business_id, initiator_user_id, system_proxy, attempts, last_reason, command_id, updated_at)
  ON employment_auto_regularization_launches TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_auto_regularization_daily_runs');
--> statement-breakpoint
GRANT SELECT, INSERT ON employment_auto_regularization_daily_runs TO app_user;
--> statement-breakpoint
-- 自动转正总开关，两层配置（租户覆盖走既有 /api/tenant/settings/:key），系统值关闭（R2e5：本租户开启，出厂关闭）
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('probation.auto_regularization_enabled','false'::jsonb,'试用期：自动转正（true 开启 / false 关闭）',true,1,now());
