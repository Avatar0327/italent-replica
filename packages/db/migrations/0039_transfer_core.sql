CREATE TABLE "transfer_form_fields" (
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"field_code" text NOT NULL,
	"mode" text NOT NULL,
	CONSTRAINT "transfer_form_fields_tenant_id_version_id_field_code_pk" PRIMARY KEY("tenant_id","version_id","field_code"),
	CONSTRAINT "transfer_form_fields_mode" CHECK ("transfer_form_fields"."mode" IN ('editable', 'readonly', 'hidden', 'absent'))
);
--> statement-breakpoint
CREATE TABLE "transfer_form_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"name" text NOT NULL,
	"group" text,
	"process_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_form_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "transfer_form_versions_number" UNIQUE("tenant_id","form_id","version_no"),
	CONSTRAINT "transfer_form_versions_number_positive" CHECK ("transfer_form_versions"."version_no" > 0),
	CONSTRAINT "transfer_form_versions_group" CHECK ("transfer_form_versions"."group" IS NULL OR "transfer_form_versions"."group" = 'transfer'),
	CONSTRAINT "transfer_form_versions_process_nonempty" CHECK (btrim("transfer_form_versions"."process_code") <> '')
);
--> statement-breakpoint
CREATE TABLE "transfer_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"form_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "transfer_forms_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "transfer_forms_tenant_form" UNIQUE("tenant_id","form_id"),
	CONSTRAINT "transfer_forms_form_nonempty" CHECK (btrim("transfer_forms"."form_id") <> ''),
	CONSTRAINT "transfer_forms_revision_nonnegative" CHECK ("transfer_forms"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transfer_reasons" (
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"effective_date" date NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_order" integer,
	"transfer_type_code" text,
	CONSTRAINT "transfer_reasons_tenant_id_code_pk" PRIMARY KEY("tenant_id","code"),
	CONSTRAINT "transfer_reasons_code_nonempty" CHECK (btrim("transfer_reasons"."code") <> ''),
	CONSTRAINT "transfer_reasons_date_finite" CHECK (isfinite("transfer_reasons"."effective_date"))
);
--> statement-breakpoint
CREATE TABLE "transfer_requests" (
	"tenant_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"transfer_type_code" text NOT NULL,
	"reason_code" text,
	"initiator" text NOT NULL,
	"process_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_requests_tenant_id_business_id_pk" PRIMARY KEY("tenant_id","business_id"),
	CONSTRAINT "transfer_requests_initiator" CHECK ("transfer_requests"."initiator" IN ('hr', 'manager', 'employee')),
	CONSTRAINT "transfer_requests_type_nonempty" CHECK (btrim("transfer_requests"."transfer_type_code") <> ''),
	CONSTRAINT "transfer_requests_process_nonempty" CHECK (btrim("transfer_requests"."process_code") <> '')
);
--> statement-breakpoint
CREATE TABLE "transfer_setting_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"unrestrict_target_department" boolean DEFAULT true NOT NULL,
	"auto_populate" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_setting_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "transfer_setting_versions_number" UNIQUE("tenant_id","version_no"),
	CONSTRAINT "transfer_setting_versions_number_positive" CHECK ("transfer_setting_versions"."version_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "transfer_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "transfer_settings_revision_nonnegative" CHECK ("transfer_settings"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transfer_types" (
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"effective_date" date NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_order" integer,
	"form_id" text NOT NULL,
	CONSTRAINT "transfer_types_tenant_id_code_pk" PRIMARY KEY("tenant_id","code"),
	CONSTRAINT "transfer_types_code_nonempty" CHECK (btrim("transfer_types"."code") <> ''),
	CONSTRAINT "transfer_types_date_finite" CHECK (isfinite("transfer_types"."effective_date"))
);
--> statement-breakpoint
ALTER TABLE "transfer_form_fields" ADD CONSTRAINT "transfer_form_fields_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_form_fields" ADD CONSTRAINT "transfer_form_fields_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."transfer_form_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_form_versions" ADD CONSTRAINT "transfer_form_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_form_versions" ADD CONSTRAINT "transfer_form_versions_form_fk" FOREIGN KEY ("tenant_id","form_id") REFERENCES "public"."transfer_forms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_forms" ADD CONSTRAINT "transfer_forms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_reasons" ADD CONSTRAINT "transfer_reasons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_requests" ADD CONSTRAINT "transfer_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_requests" ADD CONSTRAINT "transfer_requests_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_setting_versions" ADD CONSTRAINT "transfer_setting_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_setting_versions" ADD CONSTRAINT "transfer_setting_versions_settings_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."transfer_settings"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_settings" ADD CONSTRAINT "transfer_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_types" ADD CONSTRAINT "transfer_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;