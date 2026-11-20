CREATE SEQUENCE "public"."employment_origin_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "employment_field_origins" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint DEFAULT nextval('employment_origin_seq') NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"payload_version_id" uuid NOT NULL,
	"record_id" uuid,
	"field_code" text NOT NULL,
	"origin_kind" text NOT NULL,
	"value" jsonb,
	"source_business_id" uuid,
	"source_version_no" integer,
	"source_record_id" uuid,
	"match_before" jsonb,
	"derivation_rule" text,
	"reference_id" uuid,
	"ref_seq" bigint,
	"reason" text,
	"command_id" text,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_field_origins_kind_check" CHECK ("employment_field_origins"."origin_kind" IN ('inherit','deferred','resolved','none','copy','employee-input','hr-input',
        'system-input','approval-edit','hr-record','forward-update','derive','derive-edit','sequence-sync',
        'status-propagate','retain','fallback','restore'))
);
--> statement-breakpoint
ALTER TABLE "employment_field_origins" ADD CONSTRAINT "employment_field_origins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_field_origins" ADD CONSTRAINT "employment_field_origins_payload_fk" FOREIGN KEY ("tenant_id","employee_id","business_id","payload_version_id") REFERENCES "public"."employment_payload_versions"("tenant_id","employee_id","business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employment_field_origins_business_field" ON "employment_field_origins" USING btree ("tenant_id","business_id","field_code","seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "employment_field_origins_source" ON "employment_field_origins" USING btree ("tenant_id","employee_id","source_business_id");--> statement-breakpoint
CREATE INDEX "employment_field_origins_anchor" ON "employment_field_origins" USING btree ("tenant_id","business_id","field_code","derivation_rule","reference_id","seq" DESC NULLS LAST) WHERE "employment_field_origins"."derivation_rule" IS NOT NULL;
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_field_origins');
--> statement-breakpoint
GRANT SELECT, INSERT ON employment_field_origins TO app_user;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE employment_origin_seq TO app_user;
--> statement-breakpoint
CREATE TRIGGER employment_field_origins_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON employment_field_origins
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
