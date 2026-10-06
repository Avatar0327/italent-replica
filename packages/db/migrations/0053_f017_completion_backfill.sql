-- P2-02: old future reservations must not occupy the open employee/field key.
-- They close permanently; reconciliation opens a new todo only when the field is actually missing today.
UPDATE transfer_completion_todos c SET closed_at=CURRENT_TIMESTAMP
FROM tenants tenant WHERE tenant.id=c.tenant_id AND c.closed_at IS NULL
  AND c.effective_date > (CURRENT_TIMESTAMP AT TIME ZONE tenant.timezone)::date;
--> statement-breakpoint
-- P2-03: backfill from legacy clearing events and the current effective record/snapshot.
-- Persist the old reminder date on this generation only, preserving the seven-day cadence without rewriting outbox.
WITH missing AS (
  SELECT DISTINCT ON (e.tenant_id,e.employee_id,code.value)
    e.tenant_id,e.employee_id,e.business_id,code.value AS field_code,t.start_date AS effective_date,
    (SELECT max((reminder.payload->'after'->>'businessDate')::date) FROM employment_outbox reminder
      WHERE reminder.tenant_id=e.tenant_id AND reminder.business_id=e.business_id
        AND reminder.event_type='employment.completion.reminder') AS legacy_reminder_date
  FROM employment_outbox e
  JOIN tenants tenant ON tenant.id=e.tenant_id
  JOIN employment_records r ON r.tenant_id=e.tenant_id AND r.id=e.business_id
  JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
  JOIN employment_timeline current_t ON current_t.tenant_id=e.tenant_id AND current_t.employee_id=e.employee_id
    AND current_t.valid_during @> (CURRENT_TIMESTAMP AT TIME ZONE tenant.timezone)::date
  JOIN employment_records current_record ON current_record.tenant_id=current_t.tenant_id
    AND current_record.id=current_t.record_id AND current_record.service_type='primary'
  LEFT JOIN LATERAL (SELECT to_jsonb(p) AS body FROM employment_payload_versions p
    WHERE p.tenant_id=current_record.tenant_id AND p.business_id=current_record.id AND p.is_record_snapshot
    ORDER BY version_no DESC LIMIT 1) p ON true
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(
    e.payload->'meta'->'clearedFieldCodes',e.payload->'after'->'clearedFieldCodes','[]'::jsonb)) code(value)
  WHERE e.event_type='employment.record.create'
    AND t.start_date <= (CURRENT_TIMESTAMP AT TIME ZONE tenant.timezone)::date
    AND code.value LIKE 'preset:%'
    AND (COALESCE(p.body,to_jsonb(current_record))->>lower(regexp_replace(
      substring(code.value FROM 8),'([A-Z])','_\1','g'))) IS NULL
  ORDER BY e.tenant_id,e.employee_id,code.value,t.start_date DESC,t.sort_order DESC,e.id
)
INSERT INTO transfer_completion_todos
  (tenant_id,employee_id,business_id,field_code,effective_date,legacy_reminder_date)
SELECT tenant_id,employee_id,business_id,field_code,effective_date,legacy_reminder_date FROM missing
ON CONFLICT (tenant_id,employee_id,field_code) WHERE closed_at IS NULL DO NOTHING;
