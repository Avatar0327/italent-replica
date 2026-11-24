CREATE TABLE "org_adjustment_transfer_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"employee_id" uuid NOT NULL,
	"base_record_id" uuid NOT NULL,
	"base_employee_revision" integer NOT NULL,
	"department_id" uuid,
	"department_item_id" uuid,
	"position_id" uuid,
	"position_item_id" uuid,
	"post_id" uuid,
	"level_id" uuid,
	"direct_manager_id" uuid,
	"dotted_manager_id" uuid,
	"transfer_type_code" text NOT NULL,
	"form_id" text NOT NULL,
	"reason_code" text,
	"with_establishment" boolean DEFAULT false NOT NULL,
	"linkage" jsonb,
	"generated_by_item_id" uuid,
	"generated_reason" text,
	"created_business_id" uuid,
	"exec_phase" smallint DEFAULT 0 NOT NULL,
	"execution_result" smallint,
	"execution_reason" text,
	"execution_message" text,
	CONSTRAINT "org_adjustment_transfer_seq" UNIQUE("tenant_id","adjustment_id","seq"),
	CONSTRAINT "org_adjustment_transfer_business" UNIQUE("tenant_id","created_business_id"),
	CONSTRAINT "org_adjustment_transfer_department_ref" CHECK (num_nonnulls("org_adjustment_transfer_items"."department_id", "org_adjustment_transfer_items"."department_item_id") = 1),
	CONSTRAINT "org_adjustment_transfer_position_ref" CHECK (num_nonnulls("org_adjustment_transfer_items"."position_id", "org_adjustment_transfer_items"."position_item_id") <= 1),
	CONSTRAINT "org_adjustment_transfer_generation" CHECK (("org_adjustment_transfer_items"."generated_by_item_id" IS NULL) = ("org_adjustment_transfer_items"."generated_reason" IS NULL)),
	CONSTRAINT "org_adjustment_transfer_baseline" CHECK ("org_adjustment_transfer_items"."base_employee_revision" > 0 AND "org_adjustment_transfer_items"."seq" > 0),
	CONSTRAINT "org_adjustment_transfer_phase" CHECK ("org_adjustment_transfer_items"."exec_phase" IN (0, 2)),
	CONSTRAINT "org_adjustment_transfer_result" CHECK ("org_adjustment_transfer_items"."execution_result" IN (1, 2))
);
--> statement-breakpoint
ALTER TABLE "org_adjustment_transfer_items" ADD CONSTRAINT "org_adjustment_transfer_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_transfer_items" ADD CONSTRAINT "org_adjustment_transfer_adjustment_fk" FOREIGN KEY ("tenant_id","adjustment_id") REFERENCES "public"."org_adjustments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_transfer_items" ADD CONSTRAINT "org_adjustment_transfer_base_fk" FOREIGN KEY ("tenant_id","employee_id","base_record_id") REFERENCES "public"."employment_records"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_transfer_items" ADD CONSTRAINT "org_adjustment_transfer_business_fk" FOREIGN KEY ("tenant_id","employee_id","created_business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_transfer_items" ADD CONSTRAINT "org_adjustment_transfer_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_transfer_items" ADD CONSTRAINT "org_adjustment_transfer_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_transfer_items" ADD CONSTRAINT "org_adjustment_transfer_post_fk" FOREIGN KEY ("tenant_id","post_id") REFERENCES "public"."job_post_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_transfer_items" ADD CONSTRAINT "org_adjustment_transfer_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."job_level_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_transfer_items" ADD CONSTRAINT "org_adjustment_transfer_direct_manager_fk" FOREIGN KEY ("tenant_id","direct_manager_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_transfer_items" ADD CONSTRAINT "org_adjustment_transfer_dotted_manager_fk" FOREIGN KEY ("tenant_id","dotted_manager_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_transfer_items" ADD CONSTRAINT "org_adjustment_transfer_department_item_fk" FOREIGN KEY ("tenant_id","adjustment_id","department_item_id") REFERENCES "public"."org_adjustment_org_items"("tenant_id","adjustment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_transfer_items" ADD CONSTRAINT "org_adjustment_transfer_generated_by_fk" FOREIGN KEY ("tenant_id","adjustment_id","generated_by_item_id") REFERENCES "public"."org_adjustment_org_items"("tenant_id","adjustment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_adjustment_transfer_employee" ON "org_adjustment_transfer_items" USING btree ("tenant_id","employee_id");
--> statement-breakpoint
SELECT enable_tenant_isolation('org_adjustment_transfer_items');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON org_adjustment_transfer_items TO app_user;
