CREATE TABLE "succession_exit_applications" (
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"employment_record_id" uuid NOT NULL,
	"leave_date" date NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"candidate_record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ended_record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"command_id" text NOT NULL,
	CONSTRAINT "succession_exit_applications_tenant_id_employment_record_id_pk" PRIMARY KEY("tenant_id","employment_record_id"),
	CONSTRAINT "succession_exit_source" CHECK ("succession_exit_applications"."source" IN ('record_write','sweep','delete_revert')),
	CONSTRAINT "succession_exit_arrays" CHECK (jsonb_typeof("succession_exit_applications"."candidate_record_ids")='array'
      AND jsonb_typeof("succession_exit_applications"."ended_record_ids")='array')
);
--> statement-breakpoint
ALTER TABLE "succession_exit_applications" ADD CONSTRAINT "succession_exit_applications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_exit_applications" ADD CONSTRAINT "succession_exit_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_exit_applications" ADD CONSTRAINT "succession_exit_record_fk" FOREIGN KEY ("tenant_id","employment_record_id") REFERENCES "public"."employment_records"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "succession_exit_employee" ON "succession_exit_applications" USING btree ("tenant_id","employee_id");