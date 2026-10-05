-- R1-T16 审计日志（DEC-019；docs/02_业务建模/20 §5；REQ-AUD-001）：租户隔离、最小权限、只追加、按租户保留期清理。
-- 1) 对象操作日志与失败命令审计：租户隔离（标准 RLS 策略），应用角色只能新增与读取。
SELECT enable_tenant_isolation('audit_operation_logs');
--> statement-breakpoint
SELECT enable_tenant_isolation('audit_command_failures');
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_operation_logs, audit_command_failures TO app_user;
--> statement-breakpoint
-- 2) 租户审计三表只追加。唯一例外：purge_expired_audit 在本事务内打开清理开关后放行 DELETE；UPDATE、TRUNCATE
--    一律拒绝。应用角色本就没有 DELETE 权限，开关对它无效；平台审计仍用 0006 的 forbid_audit_mutation，不受影响。
CREATE FUNCTION forbid_tenant_audit_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('italent.audit_purge', true) = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '% 只允许追加，拒绝 %', TG_TABLE_NAME, TG_OP USING ERRCODE = 'object_not_in_prerequisite_state';
END $$;
--> statement-breakpoint
DROP TRIGGER audit_events_append_only ON audit_events;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_tenant_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_operation_logs_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_operation_logs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_tenant_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_command_failures_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_command_failures
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_tenant_audit_mutation();
--> statement-breakpoint
-- 3) 按租户保留期清理（20 §5 第 4 条）。保留月数由调用方按租户配置 audit.retention 解析后传入，这里再校验范围；
--    截止日 = 租户时区的业务日期 − 保留月数（与 @italent/domain addMonths 一致），“现在”取调用方时钟与库时钟的较早者，
--    调用方传入未来时间也不能提前清理。只能清理当前租户上下文的租户（属主是超级用户时不受 RLS 约束，显式过滤）。
--    新增事件同时是数据范围「创建人」的判定依据（迁移 0019 起按审计回查对象的首个新增事件），每个对象的首个
--    新增事件保留，直到创建人另有独立存储（R1-T16 遗留事项）。
CREATE FUNCTION purge_expired_audit(p_tenant uuid, p_retain_months integer, p_now timestamptz)
  RETURNS TABLE (cutoff date, data_changes integer, operation_logs integer, command_failures integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  tz text;
  boundary timestamptz;
BEGIN
  IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM current_tenant_id() THEN
    RAISE EXCEPTION 'purge_expired_audit 只能清理当前租户' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_retain_months IS NULL OR p_retain_months < 1 OR p_retain_months > 120 THEN
    RAISE EXCEPTION '日志保留期须为 1～120 个月' USING ERRCODE = 'check_violation';
  END IF;
  SELECT t.timezone INTO tz FROM tenants t WHERE t.id = p_tenant;
  cutoff := ((LEAST(coalesce(p_now, now()), now()) AT TIME ZONE tz)::date
    - make_interval(months => p_retain_months))::date;
  boundary := cutoff::timestamp AT TIME ZONE tz;
  PERFORM set_config('italent.audit_purge', 'on', true);
  DELETE FROM audit_events a
   WHERE a.tenant_id = p_tenant AND a.occurred_at < boundary
     AND NOT (a.action LIKE '%.create' AND NOT EXISTS (
       SELECT 1 FROM audit_events e
        WHERE e.tenant_id = a.tenant_id AND e.object_id = a.object_id AND e.action = a.action
          AND (e.occurred_at, e.id) < (a.occurred_at, a.id)));
  GET DIAGNOSTICS data_changes = ROW_COUNT;
  DELETE FROM audit_operation_logs o WHERE o.tenant_id = p_tenant AND o.occurred_at < boundary;
  GET DIAGNOSTICS operation_logs = ROW_COUNT;
  DELETE FROM audit_command_failures f WHERE f.tenant_id = p_tenant AND f.occurred_at < boundary;
  GET DIAGNOSTICS command_failures = ROW_COUNT;
  PERFORM set_config('italent.audit_purge', 'off', true);
  RETURN NEXT;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION purge_expired_audit(uuid, integer, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_expired_audit(uuid, integer, timestamptz) TO app_user;
