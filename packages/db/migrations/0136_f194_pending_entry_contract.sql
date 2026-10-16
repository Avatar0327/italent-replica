CREATE TABLE "employment_pending_entry_contract" (
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_pending_entry_contract_pk" PRIMARY KEY("tenant_id","business_id"),
	CONSTRAINT "employment_pending_entry_contract_dates" CHECK ("employment_pending_entry_contract"."end_date" IS NULL OR "employment_pending_entry_contract"."end_date" >= "employment_pending_entry_contract"."start_date")
);
--> statement-breakpoint
ALTER TABLE "employment_pending_entry_contract" ADD CONSTRAINT "employment_pending_entry_contract_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_pending_entry_contract" ADD CONSTRAINT "employment_pending_entry_contract_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- F-194：待入职合同，租户隔离；随待入职记录替换而搬动 / 改期同步起始日、办理入职 / 删除后清除，所以给 UPDATE / DELETE
SELECT enable_tenant_isolation('employment_pending_entry_contract');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON employment_pending_entry_contract TO app_user;
