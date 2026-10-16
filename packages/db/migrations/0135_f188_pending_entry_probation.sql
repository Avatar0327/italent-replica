CREATE TABLE "employment_pending_entry_probation" (
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"probation" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_pending_entry_probation_pk" PRIMARY KEY("tenant_id","business_id")
);
--> statement-breakpoint
ALTER TABLE "employment_entry_actions" DROP CONSTRAINT "employment_entry_actions_action";--> statement-breakpoint
ALTER TABLE "employment_entry_actions" DROP CONSTRAINT "employment_entry_actions_postpone_dates";--> statement-breakpoint
ALTER TABLE "employment_pending_entry_probation" ADD CONSTRAINT "employment_pending_entry_probation_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_pending_entry_probation" ADD CONSTRAINT "employment_pending_entry_probation_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_entry_actions" ADD CONSTRAINT "employment_entry_actions_action" CHECK ("employment_entry_actions"."action" IN ('cancel', 'postpone', 'edit'));--> statement-breakpoint
ALTER TABLE "employment_entry_actions" ADD CONSTRAINT "employment_entry_actions_postpone_dates" CHECK ("employment_entry_actions"."action" NOT IN ('postpone', 'edit') OR "employment_entry_actions"."to_date" IS NOT NULL);--> statement-breakpoint
-- F-188：待入职试用期，租户隔离；随待入职记录替换而搬动、办理入职 / 删除后清除，所以给 UPDATE / DELETE
SELECT enable_tenant_isolation('employment_pending_entry_probation');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON employment_pending_entry_probation TO app_user;
