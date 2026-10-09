CREATE TABLE "personnel_qualification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"category_id" uuid NOT NULL,
	"level_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"final_score" numeric,
	"is_auto_sync" boolean DEFAULT false NOT NULL,
	"employment_record_id" uuid,
	"activity_type_id" uuid,
	"evaluation_id" uuid,
	"result" text,
	CONSTRAINT "personnel_qualification_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "personnel_qualification_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_qualification_revision_positive" CHECK ("personnel_qualification"."revision" > 0),
	CONSTRAINT "personnel_qualification_dates" CHECK ("personnel_qualification"."end_date" IS NULL OR "personnel_qualification"."end_date" >= "personnel_qualification"."start_date"),
	CONSTRAINT "personnel_qualification_source" CHECK ("personnel_qualification"."source_type" IN ('hr_direct','self_service','info_collection','employment_sync','initialization','evaluation')
    AND (("personnel_qualification"."source_type" = 'hr_direct' AND "personnel_qualification"."source_id" IS NULL)
      OR ("personnel_qualification"."source_type" <> 'hr_direct' AND "personnel_qualification"."source_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "personnel_qualification_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"level_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"final_score" numeric,
	"is_auto_sync" boolean DEFAULT false NOT NULL,
	"employment_record_id" uuid,
	"activity_type_id" uuid,
	"evaluation_id" uuid,
	"result" text,
	CONSTRAINT "personnel_qualification_versions_revision" UNIQUE("tenant_id","record_id","revision"),
	CONSTRAINT "personnel_qualification_versions_source" CHECK ("personnel_qualification_versions"."source_type" IN ('hr_direct','self_service','info_collection','employment_sync','initialization','evaluation')
    AND (("personnel_qualification_versions"."source_type" = 'hr_direct' AND "personnel_qualification_versions"."source_id" IS NULL)
      OR ("personnel_qualification_versions"."source_type" <> 'hr_direct' AND "personnel_qualification_versions"."source_id" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "personnel_qualification" ADD CONSTRAINT "personnel_qualification_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_qualification" ADD CONSTRAINT "personnel_qualification_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_qualification" ADD CONSTRAINT "personnel_qualification_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."ql_categories"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_qualification" ADD CONSTRAINT "personnel_qualification_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."ql_levels"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_qualification_versions" ADD CONSTRAINT "personnel_qualification_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_qualification_versions" ADD CONSTRAINT "personnel_qualification_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_qualification_versions" ADD CONSTRAINT "personnel_qualification_versions_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."personnel_qualification"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personnel_qualification_employee" ON "personnel_qualification" USING btree ("tenant_id","employee_id","start_date");--> statement-breakpoint
CREATE INDEX "personnel_qualification_category" ON "personnel_qualification" USING btree ("tenant_id","category_id");--> statement-breakpoint
CREATE INDEX "personnel_qualification_level" ON "personnel_qualification" USING btree ("tenant_id","level_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personnel_qualification_evaluation_one" ON "personnel_qualification" USING btree ("tenant_id","evaluation_id") WHERE "personnel_qualification"."evaluation_id" IS NOT NULL;