-- R2-T06：统一租户隔离；版本业务字段只追加，状态投影允许更新。
SELECT enable_tenant_isolation('contract_types');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_types TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('contract_companies');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_companies TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('contract_portfolios');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_portfolios TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('contract_records');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_records TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('contract_requests');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_requests TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('contract_changes');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_changes TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('contract_settings');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_settings TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('contract_renewal_rules');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_renewal_rules TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('contract_renewal_details');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_renewal_details TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('contract_job_attempts');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_job_attempts TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('contract_outbox');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_outbox TO app_user;
--> statement-breakpoint
CREATE TRIGGER contract_changes_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON contract_changes
FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER contract_job_attempts_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON contract_job_attempts
FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_contract_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','actual_termination_date','revision','deleted']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','actual_termination_date','revision','deleted']) THEN
    RAISE EXCEPTION 'contract business fields are immutable; append a version';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER contract_version_immutable BEFORE UPDATE ON contract_records
FOR EACH ROW EXECUTE FUNCTION guard_contract_version();
