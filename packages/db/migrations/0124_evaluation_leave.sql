-- C2-1b / 设计 §4.3：迁移器在同一事务执行以下步骤，阻止旧触发器与补入快照间漏事件。
LOCK TABLE employment_outbox IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ev_enqueue_qualification_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ev_sync_queue (tenant_id, handler, dedupe_key, outbox_id, employee_id, record_id, next_attempt_at)
  VALUES (NEW.tenant_id, 'qualification_sync', NEW.id::text, NEW.id, NEW.employee_id, NEW.object_id, NEW.created_at)
  ON CONFLICT (tenant_id, handler, dedupe_key) DO NOTHING;

  INSERT INTO ev_sync_queue (tenant_id, handler, dedupe_key, outbox_id, employee_id, record_id, next_attempt_at)
  SELECT NEW.tenant_id, 'evaluation_leave', NEW.business_id::text, NEW.id, NEW.employee_id, r.id, NEW.created_at
  FROM employment_records r
  WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.object_id AND r.kind IN ('leave','retirement')
  ON CONFLICT (tenant_id, handler, dedupe_key) DO NOTHING;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- 强制 RLS 下逐租户补入，不能依赖迁移账号是超级用户；结束时恢复进入迁移前的租户上下文。
DO $$
DECLARE
  tenant_row record;
  previous_tenant text := current_setting('app.tenant_id', true);
BEGIN
  FOR tenant_row IN SELECT id, timezone FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tenant_row.id::text, true);
    -- 任职记录 ID 即业务单 ID；旧版不曾入资格队列也能由原始事件补入。
    -- 仍在时间轴上且近期或周期已有评定，覆盖未来离职及跨多日升级。
    INSERT INTO ev_sync_queue
      (tenant_id, handler, dedupe_key, outbox_id, employee_id, record_id, next_attempt_at)
    -- 与实时入队相同：日期准入交给 F-055，不能用未来 next_attempt_at 挡住已删除事件。
    SELECT r.tenant_id, 'evaluation_leave', r.id::text, event.id, r.employee_id, r.id, event.created_at
    FROM employment_records r
    JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
    JOIN LATERAL (
      SELECT e.id, e.created_at FROM employment_outbox e
      WHERE e.tenant_id=r.tenant_id AND e.business_id=r.id AND e.object_id=r.id
        AND e.event_type='employment.record.create' ORDER BY e.created_at, e.id LIMIT 1
    ) event ON true
    WHERE r.tenant_id=tenant_row.id AND r.kind IN ('leave','retirement')
      AND (r.start_date>=CURRENT_DATE-1 OR EXISTS (
        SELECT 1 FROM ev_staff_evaluations ev WHERE ev.tenant_id=r.tenant_id AND ev.cycle_id=r.staff_id))
    ON CONFLICT (tenant_id, handler, dedupe_key) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
END
$$;
