CREATE TABLE "retirement_rule_daily_runs" (
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"business_date" date NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"position_employee_id" uuid,
	"lease_until" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"command_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retirement_rule_daily_runs_pk" PRIMARY KEY("tenant_id","purpose","business_date"),
	CONSTRAINT "retirement_rule_daily_runs_purpose" CHECK ("retirement_rule_daily_runs"."purpose" IN ('expected_date', 'flexible_range')),
	CONSTRAINT "retirement_rule_daily_runs_state" CHECK ("retirement_rule_daily_runs"."state" IN ('running', 'done')),
	CONSTRAINT "retirement_rule_daily_runs_attempts" CHECK ("retirement_rule_daily_runs"."attempts" > 0 AND "retirement_rule_daily_runs"."skipped_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "retirement_rule_run_cursors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"business_date" date NOT NULL,
	"position_employee_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retirement_rule_run_cursors_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "retirement_rule_run_cursors_purpose" CHECK ("retirement_rule_run_cursors"."purpose" IN ('expected_date', 'flexible_range'))
);
--> statement-breakpoint
CREATE TABLE "retirement_rule_run_skips" (
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"business_date" date NOT NULL,
	"employee_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retirement_rule_run_skips_pk" PRIMARY KEY("tenant_id","purpose","business_date","employee_id"),
	CONSTRAINT "retirement_rule_run_skips_state" CHECK ("retirement_rule_run_skips"."state" IN ('pending', 'given_up'))
);
--> statement-breakpoint
ALTER TABLE "retirement_rule_daily_runs" ADD CONSTRAINT "retirement_rule_daily_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_rule_run_cursors" ADD CONSTRAINT "retirement_rule_run_cursors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_rule_run_skips" ADD CONSTRAINT "retirement_rule_run_skips_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_rule_run_skips" ADD CONSTRAINT "retirement_rule_run_skips_run_fk" FOREIGN KEY ("tenant_id","purpose","business_date") REFERENCES "public"."retirement_rule_daily_runs"("tenant_id","purpose","business_date") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- R2 BE-5c2：租户隔离与授权。每日批次行逐列授权（进度只能推进、不能改主键与创建信息）；跳过清单可删、可改状态；
-- 续跑句柄只增不改（不授 UPDATE / DELETE）
SELECT enable_tenant_isolation('retirement_rule_daily_runs');
--> statement-breakpoint
GRANT SELECT, INSERT ON retirement_rule_daily_runs TO app_user;
--> statement-breakpoint
GRANT UPDATE (state, position_employee_id, lease_until, attempts, skipped_count, command_id, updated_at)
  ON retirement_rule_daily_runs TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('retirement_rule_run_skips');
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON retirement_rule_run_skips TO app_user;
--> statement-breakpoint
GRANT UPDATE (state) ON retirement_rule_run_skips TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('retirement_rule_run_cursors');
--> statement-breakpoint
GRANT SELECT, INSERT ON retirement_rule_run_cursors TO app_user;
