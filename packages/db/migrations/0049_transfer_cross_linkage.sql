CREATE TABLE "transfer_handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"handover_person_id" uuid,
	"handover_status" text NOT NULL,
	"approval_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_handovers_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "transfer_handovers_business" UNIQUE("tenant_id","business_id"),
	CONSTRAINT "transfer_handovers_status" CHECK ("transfer_handovers"."handover_status" IN ('not_started'))
);
--> statement-breakpoint
CREATE TABLE "transfer_linkage_duties" (
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_type" text NOT NULL,
	"subordinate_id" uuid,
	"relation" text,
	"org_id" uuid,
	"org_role" text,
	"receiver_id" uuid NOT NULL,
	CONSTRAINT "transfer_linkage_duties_tenant_id_version_id_line_no_pk" PRIMARY KEY("tenant_id","version_id","line_no"),
	CONSTRAINT "transfer_linkage_duties_line_positive" CHECK ("transfer_linkage_duties"."line_no" > 0),
	CONSTRAINT "transfer_linkage_duties_shape" CHECK ("transfer_linkage_duties"."item_type" = 'duty_subordinate' AND "transfer_linkage_duties"."subordinate_id" IS NOT NULL
          AND "transfer_linkage_duties"."relation" IN ('direct', 'dotted') AND "transfer_linkage_duties"."org_id" IS NULL AND "transfer_linkage_duties"."org_role" IS NULL
        OR "transfer_linkage_duties"."item_type" = 'duty_org_role' AND "transfer_linkage_duties"."org_id" IS NOT NULL
          AND "transfer_linkage_duties"."org_role" IN ('person_in_charge', 'shop_owner', 'hrbp')
          AND "transfer_linkage_duties"."subordinate_id" IS NULL AND "transfer_linkage_duties"."relation" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "transfer_linkage_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_type" text NOT NULL,
	"subordinate_id" uuid,
	"relation" text,
	"org_id" uuid,
	"org_role" text,
	"receiver_id" uuid,
	"part_time_record_id" uuid,
	"effective_date" date NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"failure_rule" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_linkage_items_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "transfer_linkage_items_line" UNIQUE("tenant_id","business_id","line_no"),
	CONSTRAINT "transfer_linkage_items_type" CHECK ("transfer_linkage_items"."item_type" IN ('duty_subordinate', 'duty_org_role', 'part_time_end')),
	CONSTRAINT "transfer_linkage_items_status" CHECK ("transfer_linkage_items"."status" IN ('pending', 'succeeded', 'failed')),
	CONSTRAINT "transfer_linkage_items_failure" CHECK (("transfer_linkage_items"."status" = 'failed') = ("transfer_linkage_items"."failure_code" IS NOT NULL)),
	CONSTRAINT "transfer_linkage_items_counts" CHECK ("transfer_linkage_items"."attempt_count" >= 0 AND "transfer_linkage_items"."revision" > 0 AND "transfer_linkage_items"."line_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "transfer_linkage_runs" (
	"tenant_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"before_contract_id" uuid,
	"after_contract_id" uuid,
	"salary_reminder_status" text,
	"command_id" text NOT NULL,
	"executed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "transfer_linkage_runs_tenant_id_business_id_pk" PRIMARY KEY("tenant_id","business_id"),
	CONSTRAINT "transfer_linkage_runs_contract" CHECK (("transfer_linkage_runs"."before_contract_id" IS NULL) = ("transfer_linkage_runs"."after_contract_id" IS NULL)),
	CONSTRAINT "transfer_linkage_runs_salary" CHECK ("transfer_linkage_runs"."salary_reminder_status" IS NULL OR "transfer_linkage_runs"."salary_reminder_status" = 'pending')
);
--> statement-breakpoint
CREATE TABLE "transfer_linkage_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"change_contract" boolean DEFAULT false NOT NULL,
	"contract_target_id" uuid,
	"contract_fields" jsonb,
	"adjust_salary" boolean DEFAULT false NOT NULL,
	"on_trial_start_date" date,
	"on_trial_months" integer,
	"handover" boolean DEFAULT false NOT NULL,
	"handover_person_id" uuid,
	"part_time_record_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_linkage_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "transfer_linkage_versions_number" UNIQUE("tenant_id","business_id","version_no"),
	CONSTRAINT "transfer_linkage_versions_number_positive" CHECK ("transfer_linkage_versions"."version_no" > 0),
	CONSTRAINT "transfer_linkage_versions_contract" CHECK ("transfer_linkage_versions"."change_contract" = ("transfer_linkage_versions"."contract_target_id" IS NOT NULL AND "transfer_linkage_versions"."contract_fields" IS NOT NULL)),
	CONSTRAINT "transfer_linkage_versions_trial" CHECK ("transfer_linkage_versions"."on_trial_months" IS NULL AND "transfer_linkage_versions"."on_trial_start_date" IS NULL
        OR "transfer_linkage_versions"."on_trial_months" BETWEEN 1 AND 60 AND ("transfer_linkage_versions"."on_trial_start_date" IS NULL OR isfinite("transfer_linkage_versions"."on_trial_start_date"))),
	CONSTRAINT "transfer_linkage_versions_handover" CHECK ("transfer_linkage_versions"."handover" OR "transfer_linkage_versions"."handover_person_id" IS NULL),
	CONSTRAINT "transfer_linkage_versions_part_times" CHECK (cardinality("transfer_linkage_versions"."part_time_record_ids") <= 50)
);
--> statement-breakpoint
CREATE TABLE "transfer_on_trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"months" integer NOT NULL,
	"expected_end_date" date NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_on_trials_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "transfer_on_trials_business" UNIQUE("tenant_id","business_id"),
	CONSTRAINT "transfer_on_trials_months" CHECK ("transfer_on_trials"."months" BETWEEN 1 AND 60),
	CONSTRAINT "transfer_on_trials_dates" CHECK ("transfer_on_trials"."expected_end_date" >= "transfer_on_trials"."start_date"),
	CONSTRAINT "transfer_on_trials_status" CHECK ("transfer_on_trials"."status" IN ('in_trial'))
);
--> statement-breakpoint
ALTER TABLE "transfer_handovers" ADD CONSTRAINT "transfer_handovers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_handovers" ADD CONSTRAINT "transfer_handovers_run_fk" FOREIGN KEY ("tenant_id","business_id") REFERENCES "public"."transfer_linkage_runs"("tenant_id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_linkage_duties" ADD CONSTRAINT "transfer_linkage_duties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_linkage_duties" ADD CONSTRAINT "transfer_linkage_duties_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."transfer_linkage_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_linkage_items" ADD CONSTRAINT "transfer_linkage_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_linkage_items" ADD CONSTRAINT "transfer_linkage_items_run_fk" FOREIGN KEY ("tenant_id","business_id") REFERENCES "public"."transfer_linkage_runs"("tenant_id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_linkage_runs" ADD CONSTRAINT "transfer_linkage_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_linkage_runs" ADD CONSTRAINT "transfer_linkage_runs_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."transfer_linkage_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_linkage_runs" ADD CONSTRAINT "transfer_linkage_runs_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_linkage_versions" ADD CONSTRAINT "transfer_linkage_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_linkage_versions" ADD CONSTRAINT "transfer_linkage_versions_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_on_trials" ADD CONSTRAINT "transfer_on_trials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_on_trials" ADD CONSTRAINT "transfer_on_trials_run_fk" FOREIGN KEY ("tenant_id","business_id") REFERENCES "public"."transfer_linkage_runs"("tenant_id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- R1-T10：联动表全部强制租户隔离（硬规则 7）；选项版本、职责计划、执行结果只追加，子项只允许状态推进。
SELECT enable_tenant_isolation('transfer_linkage_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON transfer_linkage_versions TO app_user;
--> statement-breakpoint
CREATE TRIGGER transfer_linkage_versions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON transfer_linkage_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('transfer_linkage_duties');
--> statement-breakpoint
GRANT SELECT, INSERT ON transfer_linkage_duties TO app_user;
--> statement-breakpoint
CREATE TRIGGER transfer_linkage_duties_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON transfer_linkage_duties FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('transfer_linkage_runs');
--> statement-breakpoint
GRANT SELECT, INSERT ON transfer_linkage_runs TO app_user;
--> statement-breakpoint
CREATE TRIGGER transfer_linkage_runs_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON transfer_linkage_runs FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('transfer_linkage_items');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON transfer_linkage_items TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('transfer_on_trials');
--> statement-breakpoint
GRANT SELECT, INSERT ON transfer_on_trials TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('transfer_handovers');
--> statement-breakpoint
GRANT SELECT, INSERT ON transfer_handovers TO app_user;
