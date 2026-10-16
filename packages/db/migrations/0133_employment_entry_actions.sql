CREATE TABLE "employment_entry_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"previous_business_id" uuid,
	"action" text NOT NULL,
	"reason_code" text,
	"remark" text,
	"from_date" date,
	"to_date" date,
	"command_id" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_entry_actions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_entry_actions_action" CHECK ("employment_entry_actions"."action" IN ('cancel', 'postpone')),
	CONSTRAINT "employment_entry_actions_reason" CHECK ("employment_entry_actions"."reason_code" IS NULL OR btrim("employment_entry_actions"."reason_code") <> ''),
	CONSTRAINT "employment_entry_actions_postpone_dates" CHECK ("employment_entry_actions"."action" <> 'postpone' OR "employment_entry_actions"."to_date" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "employment_entry_actions" ADD CONSTRAINT "employment_entry_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_entry_actions" ADD CONSTRAINT "employment_entry_actions_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employment_entry_actions_business" ON "employment_entry_actions" USING btree ("tenant_id","business_id","created_at");--> statement-breakpoint
-- R2 BE-2a：待入职取消 / 改期日志，租户隔离、只追加（不给 UPDATE / DELETE）
SELECT enable_tenant_isolation('employment_entry_actions');
--> statement-breakpoint
GRANT SELECT, INSERT ON employment_entry_actions TO app_user;
--> statement-breakpoint
CREATE TRIGGER employment_entry_actions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON employment_entry_actions FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
