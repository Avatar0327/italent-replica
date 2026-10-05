CREATE TABLE "contract_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"organization_id" uuid,
	"before_contract_id" uuid NOT NULL,
	"after_contract_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "contract_companies_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "contract_companies_code" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "contract_job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"error" text,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"command_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "contract_portfolio_employee" UNIQUE("tenant_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "contract_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"number" text NOT NULL,
	"type_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"term_type" text NOT NULL,
	"term_months" integer,
	"signing_date" date,
	"effective_date" date NOT NULL,
	"end_date" date,
	"actual_termination_date" date,
	"probation_start_date" date,
	"probation_end_date" date,
	"probation_salary" numeric,
	"regular_salary" numeric,
	"signing_count" integer NOT NULL,
	"employment_record_id" uuid,
	"source_code" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"previous_contract_id" uuid,
	"root_contract_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'valid' NOT NULL,
	"approval_status" text DEFAULT 'effective' NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_records_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "contract_records_status" CHECK ("contract_records"."status" IN ('valid','terminated','void')),
	CONSTRAINT "contract_records_dates" CHECK ("contract_records"."end_date" IS NULL OR "contract_records"."end_date" > "contract_records"."effective_date"),
	CONSTRAINT "contract_records_term" CHECK ("contract_records"."term_type" IN ('fixed','indefinite','task'))
);
--> statement-breakpoint
CREATE TABLE "contract_renewal_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"months" integer NOT NULL,
	"initiator_id" uuid NOT NULL,
	"days_before" integer NOT NULL,
	"skip_type_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "contract_detail_type" UNIQUE("tenant_id","rule_id","type_id")
);
--> statement-breakpoint
CREATE TABLE "contract_renewal_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"org_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"person_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "contract_rules_tenant_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "contract_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"number" text NOT NULL,
	"type_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"term_type" text NOT NULL,
	"term_months" integer,
	"signing_date" date,
	"effective_date" date NOT NULL,
	"end_date" date,
	"actual_termination_date" date,
	"probation_start_date" date,
	"probation_end_date" date,
	"probation_salary" numeric,
	"regular_salary" numeric,
	"signing_count" integer NOT NULL,
	"employment_record_id" uuid,
	"source_code" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"operation" text NOT NULL,
	"mode" text NOT NULL,
	"target_id" uuid,
	"target_revision" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"result_id" uuid,
	"created_by" uuid NOT NULL,
	"system_initiated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_requests_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "contract_requests_status" CHECK ("contract_requests"."status" IN ('in_review','approved','returned','withdrawn','effective','declined'))
);
--> statement-breakpoint
CREATE TABLE "contract_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"auto_terminate" boolean DEFAULT false NOT NULL,
	"auto_number" boolean DEFAULT true NOT NULL,
	"accumulate_rehire" boolean DEFAULT true NOT NULL,
	"post_exit_type_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"renewal_type_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"indefinite_type_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"unique_fields" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "contract_types_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "contract_types_code" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
ALTER TABLE "approval_instances" DROP CONSTRAINT "approval_instances_business_type";--> statement-breakpoint
ALTER TABLE "contract_changes" ADD CONSTRAINT "contract_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_changes" ADD CONSTRAINT "contract_changes_tenant_id_before_contract_id_contract_records_tenant_id_id_fk" FOREIGN KEY ("tenant_id","before_contract_id") REFERENCES "public"."contract_records"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_changes" ADD CONSTRAINT "contract_changes_tenant_id_after_contract_id_contract_records_tenant_id_id_fk" FOREIGN KEY ("tenant_id","after_contract_id") REFERENCES "public"."contract_records"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_changes" ADD CONSTRAINT "contract_changes_tenant_id_request_id_contract_requests_tenant_id_id_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."contract_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_companies" ADD CONSTRAINT "contract_companies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_job_attempts" ADD CONSTRAINT "contract_job_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_outbox" ADD CONSTRAINT "contract_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_portfolios" ADD CONSTRAINT "contract_portfolios_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_portfolios" ADD CONSTRAINT "contract_portfolios_tenant_id_employee_id_employment_employees_tenant_id_id_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_records" ADD CONSTRAINT "contract_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_records" ADD CONSTRAINT "contract_records_tenant_id_employee_id_employment_employees_tenant_id_id_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_records" ADD CONSTRAINT "contract_records_tenant_id_type_id_contract_types_tenant_id_id_fk" FOREIGN KEY ("tenant_id","type_id") REFERENCES "public"."contract_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_records" ADD CONSTRAINT "contract_records_tenant_id_company_id_contract_companies_tenant_id_id_fk" FOREIGN KEY ("tenant_id","company_id") REFERENCES "public"."contract_companies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_renewal_details" ADD CONSTRAINT "contract_renewal_details_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_renewal_details" ADD CONSTRAINT "contract_renewal_details_tenant_id_rule_id_contract_renewal_rules_tenant_id_id_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."contract_renewal_rules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_renewal_details" ADD CONSTRAINT "contract_renewal_details_tenant_id_type_id_contract_types_tenant_id_id_fk" FOREIGN KEY ("tenant_id","type_id") REFERENCES "public"."contract_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_renewal_rules" ADD CONSTRAINT "contract_renewal_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD CONSTRAINT "contract_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD CONSTRAINT "contract_requests_tenant_id_employee_id_employment_employees_tenant_id_id_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD CONSTRAINT "contract_requests_tenant_id_target_id_contract_records_tenant_id_id_fk" FOREIGN KEY ("tenant_id","target_id") REFERENCES "public"."contract_records"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD CONSTRAINT "contract_requests_tenant_id_type_id_contract_types_tenant_id_id_fk" FOREIGN KEY ("tenant_id","type_id") REFERENCES "public"."contract_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD CONSTRAINT "contract_requests_tenant_id_company_id_contract_companies_tenant_id_id_fk" FOREIGN KEY ("tenant_id","company_id") REFERENCES "public"."contract_companies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_settings" ADD CONSTRAINT "contract_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_types" ADD CONSTRAINT "contract_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_job_lookup" ON "contract_job_attempts" USING btree ("tenant_id","object_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_records_number" ON "contract_records" USING btree ("tenant_id","number") WHERE NOT "contract_records"."deleted" AND "contract_records"."status"<>'void';--> statement-breakpoint
CREATE INDEX "contract_records_employee" ON "contract_records" USING btree ("tenant_id","employee_id","effective_date");--> statement-breakpoint
CREATE INDEX "contract_records_due" ON "contract_records" USING btree ("tenant_id","end_date");--> statement-breakpoint
CREATE INDEX "contract_requests_due" ON "contract_requests" USING btree ("tenant_id","status","effective_date");--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_business_type" CHECK ("approval_instances"."business_type" IN ('employment','personnel_change','contract'));