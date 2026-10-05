-- DEC-185: tenant-isolated persistent completion lifecycle. Closed rows cannot reopen.
SELECT enable_tenant_isolation('transfer_completion_todos');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON transfer_completion_todos TO app_user;
--> statement-breakpoint
CREATE FUNCTION protect_transfer_completion_lifecycle() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL
    OR (to_jsonb(NEW)-'closed_at') IS DISTINCT FROM (to_jsonb(OLD)-'closed_at') THEN
    RAISE EXCEPTION 'completion todos may only close once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER transfer_completion_todos_close_once BEFORE UPDATE ON transfer_completion_todos
  FOR EACH ROW EXECUTE FUNCTION protect_transfer_completion_lifecycle();
--> statement-breakpoint
CREATE TRIGGER transfer_completion_todos_no_removal BEFORE DELETE OR TRUNCATE ON transfer_completion_todos
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
-- DEC-188: one-time deployment baseline, per tenant local date; due today/future remain queued.
INSERT INTO employment_activation_attempts
  (tenant_id,employee_id,business_id,attempt_no,outcome,reason,detail,business_date,trigger,command_id)
SELECT r.tenant_id,r.employee_id,r.id,1,'effective',NULL,
  jsonb_build_object('reason','DEPLOYMENT_BASELINE','originalEffectiveDate',t.start_date,'baselineAt',CURRENT_TIMESTAMP),
  (CURRENT_TIMESTAMP AT TIME ZONE tenant.timezone)::date,'scheduler','migration:F-017:baseline'
FROM employment_records r
JOIN tenants tenant ON tenant.id=r.tenant_id
JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
JOIN LATERAL (SELECT state FROM employment_state_events s
  WHERE s.tenant_id=r.tenant_id AND s.business_id=r.id ORDER BY event_no DESC LIMIT 1) state ON true
WHERE r.kind='transfer' AND state.state='effective'
  AND r.start_date > (r.created_at AT TIME ZONE tenant.timezone)::date
  AND t.start_date < (CURRENT_TIMESTAMP AT TIME ZONE tenant.timezone)::date
  AND NOT EXISTS (SELECT 1 FROM employment_activation_attempts a WHERE a.tenant_id=r.tenant_id AND a.business_id=r.id);
