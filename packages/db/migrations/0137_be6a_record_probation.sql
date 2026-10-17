CREATE TABLE "employment_record_probation" (
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"months" integer NOT NULL,
	"expected_end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_record_probation_pk" PRIMARY KEY("tenant_id","business_id"),
	CONSTRAINT "employment_record_probation_months" CHECK ("employment_record_probation"."months" > 0),
	CONSTRAINT "employment_record_probation_dates" CHECK ("employment_record_probation"."expected_end_date" >= "employment_record_probation"."start_date")
);
--> statement-breakpoint
ALTER TABLE "employment_payload_versions" DROP CONSTRAINT "employment_payload_versions_change_type";--> statement-breakpoint
ALTER TABLE "employment_records" DROP CONSTRAINT "employment_records_change_type";--> statement-breakpoint
ALTER TABLE "employment_record_probation" ADD CONSTRAINT "employment_record_probation_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_record_probation" ADD CONSTRAINT "employment_record_probation_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_change_type" CHECK ("employment_payload_versions"."change_type" IN ('position_adjustment', 'intern_regularization'));--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_change_type" CHECK ("employment_records"."change_type" IN ('position_adjustment', 'intern_regularization'));--> statement-breakpoint
-- BE-6a：任职试用期信息，租户隔离；随记录一次写入、不原地改，记录删除后读取经现存记录关联，所以只给 SELECT / INSERT
SELECT enable_tenant_isolation('employment_record_probation');
--> statement-breakpoint
GRANT SELECT, INSERT ON employment_record_probation TO app_user;
