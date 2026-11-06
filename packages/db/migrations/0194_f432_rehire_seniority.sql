CREATE TABLE "employment_rehire_seniority_snapshots" (
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"snapshot_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_rehire_seniority_snapshots_tenant_id_business_id_pk" PRIMARY KEY("tenant_id","business_id")
);
--> statement-breakpoint
ALTER TABLE "employment_rehire_seniority_snapshots" ADD CONSTRAINT "employment_rehire_seniority_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_rehire_seniority_snapshots" ADD CONSTRAINT "employment_rehire_seniority_snapshot_fk" FOREIGN KEY ("tenant_id","employee_id","business_id","snapshot_version_id") REFERENCES "public"."employment_payload_versions"("tenant_id","employee_id","business_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_rehire_seniority_snapshots');
--> statement-breakpoint
GRANT SELECT, INSERT ON employment_rehire_seniority_snapshots TO app_user;
--> statement-breakpoint
CREATE TRIGGER employment_rehire_seniority_snapshots_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON employment_rehire_seniority_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
-- DEC-796：仅离职重聘累计；实习与退休返聘不登记配置。
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('employment.rehire_accumulate_seniority','false'::jsonb,'离职重聘累计司龄',true,1,now());
