CREATE TABLE "employment_probation_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_probation_results_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_probation_results_code_nonempty" CHECK (btrim("employment_probation_results"."code") <> ''),
	CONSTRAINT "employment_probation_results_name_nonempty" CHECK (btrim("employment_probation_results"."name") <> ''),
	CONSTRAINT "employment_probation_results_revision_positive" CHECK ("employment_probation_results"."revision" > 0),
	CONSTRAINT "employment_probation_results_display_order" CHECK ("employment_probation_results"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "employment_probation_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"has_probation" boolean NOT NULL,
	"start_date" date,
	"months" smallint,
	"expected_end_date" date,
	"source" text NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_probation_versions_no" UNIQUE("tenant_id","business_id","version_no"),
	CONSTRAINT "employment_probation_versions_source" CHECK ("employment_probation_versions"."source" IN ('entry', 'adjust')),
	CONSTRAINT "employment_probation_versions_months" CHECK ("employment_probation_versions"."months" IS NULL OR "employment_probation_versions"."months" BETWEEN 1 AND 6),
	CONSTRAINT "employment_probation_versions_none" CHECK ("employment_probation_versions"."has_probation" OR ("employment_probation_versions"."start_date" IS NULL AND "employment_probation_versions"."months" IS NULL AND "employment_probation_versions"."expected_end_date" IS NULL)),
	CONSTRAINT "employment_probation_versions_dates" CHECK ("employment_probation_versions"."expected_end_date" IS NULL OR "employment_probation_versions"."start_date" IS NULL OR "employment_probation_versions"."expected_end_date" >= "employment_probation_versions"."start_date")
);
--> statement-breakpoint
CREATE TABLE "employment_regularization_results" (
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"result_code" text NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_regularization_results_pk" PRIMARY KEY("tenant_id","business_id")
);
--> statement-breakpoint
ALTER TABLE "employment_probation_results" ADD CONSTRAINT "employment_probation_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_probation_versions" ADD CONSTRAINT "employment_probation_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_probation_versions" ADD CONSTRAINT "employment_probation_versions_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_regularization_results" ADD CONSTRAINT "employment_regularization_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_regularization_results" ADD CONSTRAINT "employment_regularization_results_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employment_probation_results_code" ON "employment_probation_results" USING btree ("tenant_id",lower("code"));--> statement-breakpoint
-- R2 BE-3：试用期信息版本链与转正试用结果只追加（不给 UPDATE / DELETE）；试用结果字典照离职字典只开放改名 / 启停 / 顺序
SELECT enable_tenant_isolation('employment_probation_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_regularization_results');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_probation_results');
--> statement-breakpoint
GRANT SELECT, INSERT ON employment_probation_versions, employment_regularization_results, employment_probation_results
  TO app_user;
--> statement-breakpoint
GRANT UPDATE (name, enabled, display_order, revision, updated_at) ON employment_probation_results TO app_user;
--> statement-breakpoint
CREATE TRIGGER employment_probation_versions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON employment_probation_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER employment_regularization_results_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON employment_regularization_results FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
