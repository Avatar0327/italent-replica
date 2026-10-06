-- R1-T16 审计日志（DEC-019 / 197 / 198 / 199；docs/02_业务建模/20 §5；REQ-AUD-001）：
-- 租户隔离、最小权限、只追加、统一推导（含集合 SQL 与历史行）、创建人最小元数据、按租户保留期清理、平台失败通道。
--
-- 1) 租户级审计表：标准租户 RLS；应用角色只能新增与读取。
SELECT enable_tenant_isolation('audit_operation_logs');
--> statement-breakpoint
SELECT enable_tenant_isolation('audit_command_failures');
--> statement-breakpoint
SELECT enable_tenant_isolation('audit_object_creators');
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_operation_logs, audit_command_failures, audit_object_creators TO app_user;
--> statement-breakpoint
-- DEC-199：平台命令失败只授予平台角色（平台层受限通道，guard-rls 豁免清单登记）。
GRANT SELECT, INSERT ON platform_command_failures TO app_platform;
--> statement-breakpoint
CREATE TRIGGER platform_command_failures_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON platform_command_failures
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_object_creators_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_object_creators
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
-- 2) 租户审计三表只追加。唯一例外：purge_expired_audit 在本事务内打开清理开关后放行 DELETE；UPDATE、TRUNCATE
--    一律拒绝。应用角色本就没有 DELETE 权限；平台审计仍用 0006 的 forbid_audit_mutation。
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
-- 3) 当前租户的时区（DEC-056）：引用名称按审计时点的租户业务日期取有效版本（P2-5）。应用角色不能读平台租户表，
--    定义者函数只回答当前租户上下文的时区。
CREATE FUNCTION current_tenant_timezone() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT t.timezone FROM tenants t WHERE t.id = current_tenant_id() $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION current_tenant_timezone() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION current_tenant_timezone() TO app_user;
--> statement-breakpoint
-- 4) 字段级差异与操作类型：与 @italent/domain audit/changes.ts 同一规则（嵌套对象展开一层为 a.b；技术字段不计；
--    空值与空串视为相同），供集合 SQL 写入（如人员序码重算，P2-6）与历史行回填（P2-3）共用。
CREATE FUNCTION audit_is_uuid(value text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' $$;
--> statement-breakpoint
CREATE FUNCTION audit_blank(value jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT value IS NULL OR value = 'null'::jsonb OR value = '""'::jsonb $$;
--> statement-breakpoint
-- 行数估计取 20（默认 1000 会让差异函数的计划代价越过 JIT 阈值，触发器里逐行 JIT 编译，万人重算会慢上千倍）
CREATE FUNCTION audit_flatten(value jsonb) RETURNS TABLE (path text, val jsonb)
  LANGUAGE sql IMMUTABLE ROWS 20
  AS $$
    SELECT 'value', value WHERE value IS NOT NULL AND jsonb_typeof(value) NOT IN ('object', 'null')
    UNION ALL
    SELECT e.key, e.value
      FROM jsonb_each(CASE WHEN jsonb_typeof(value) = 'object' THEN value ELSE '{}'::jsonb END) e
     WHERE jsonb_typeof(e.value) <> 'object'
    UNION ALL
    SELECT e.key || '.' || n.key, n.value
      FROM jsonb_each(CASE WHEN jsonb_typeof(value) = 'object' THEN value ELSE '{}'::jsonb END) e
     CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(e.value) = 'object' THEN e.value ELSE '{}'::jsonb END) n
  $$;
--> statement-breakpoint
-- 逐行触发器里调用：关闭 JIT，单次调用不应承担 JIT 编译开销
CREATE FUNCTION audit_jsonb_diff(before jsonb, after jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET jit = off
  AS $$
    WITH l AS (SELECT * FROM audit_flatten(before)), r AS (SELECT * FROM audit_flatten(after)),
    k AS (SELECT path FROM l UNION SELECT path FROM r)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('field', k.path, 'from', COALESCE(l.val, 'null'::jsonb),
        'to', COALESCE(r.val, 'null'::jsonb)) ORDER BY k.path COLLATE "C"), '[]'::jsonb)
      FROM k LEFT JOIN l ON l.path = k.path LEFT JOIN r ON r.path = k.path
     WHERE regexp_replace(k.path, '^.*\.', '') NOT IN ('id', 'tenantId', 'revision', 'employeeRevision', 'createdAt',
             'updatedAt', 'payloadVersionId', 'versionId', 'versionNo', 'previousVersionId')
       AND NOT (audit_blank(l.val) AND audit_blank(r.val))
       AND l.val IS DISTINCT FROM r.val
  $$;
--> statement-breakpoint
CREATE FUNCTION audit_operation_of(action text, before jsonb, after jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT CASE
      WHEN regexp_replace(action, '^.*\.', '') IN ('create', 'insert', 'add', 'initialize', 'provision', 'bootstrap')
        THEN 'create'
      WHEN regexp_replace(action, '^.*\.', '') IN ('delete', 'remove', 'exit_delete') THEN 'delete'
      WHEN (before IS NULL OR before = 'null'::jsonb) AND NOT (after IS NULL OR after = 'null'::jsonb) THEN 'create'
      WHEN NOT (before IS NULL OR before = 'null'::jsonb) AND (after IS NULL OR after = 'null'::jsonb) THEN 'delete'
      WHEN jsonb_typeof(after) = 'object' AND after -> 'deleted' = 'true'::jsonb THEN 'delete'
      WHEN (before IS NULL OR before = 'null'::jsonb) AND (after IS NULL OR after = 'null'::jsonb) THEN 'other'
      ELSE 'update'
    END
  $$;
--> statement-breakpoint
-- 5) DEC-197 归属：对象类型 → 权限对象编码（字段权限）、所属人员、所属组织。只读本租户（调用方的 RLS + 显式租户条件）。
--    任职以“记录部门 ∪ 员工当前部门”判断（DEC-177），合同 / 人员信息以人员判断，组织 / 编制 / 职位以组织判断；
--    其余职务体系对象只有权限对象编码。推导不出归属时保持为空，查询端对需要归属的对象按 fail-closed 处理
--    （PR #75 第三轮 P1-1：“推导失败”不等于“无归属”）；对象类型与查看规则的完整登记在 apps/api/src/audit/visibility.ts。
CREATE FUNCTION audit_json_uuid(before jsonb, after jsonb, key text) RETURNS uuid
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT candidate::uuid FROM unnest(ARRAY[
      CASE WHEN jsonb_typeof(after) = 'object' THEN after ->> key END,
      CASE WHEN jsonb_typeof(after) = 'object' AND jsonb_typeof(after -> 'fields') = 'object'
        THEN after -> 'fields' ->> key END,
      CASE WHEN jsonb_typeof(before) = 'object' THEN before ->> key END,
      CASE WHEN jsonb_typeof(before) = 'object' AND jsonb_typeof(before -> 'fields') = 'object'
        THEN before -> 'fields' ->> key END
    ]) WITH ORDINALITY AS c(candidate, ord)
     WHERE audit_is_uuid(candidate) ORDER BY ord LIMIT 1
  $$;
--> statement-breakpoint
CREATE FUNCTION audit_scope_anchor(object_type text, object_id text, before jsonb, after jsonb)
  RETURNS TABLE (scope_object text, employee uuid, org uuid)
  LANGUAGE plpgsql STABLE
  AS $$
DECLARE
  tenant uuid := current_tenant_id();
  target uuid := CASE WHEN audit_is_uuid(object_id) THEN object_id::uuid END;
BEGIN
  scope_object := NULL; employee := NULL; org := NULL;
  IF object_type IN ('employment-record', 'employment-business', 'employment_assignment') THEN
    -- 职位同步经理写的 employment_assignment 以任职记录编号（即任职业务编号）为对象编号
    scope_object := 'TenantBase.EmploymentRecord';
    SELECT b.employee_id INTO employee FROM employment_business_objects b
     WHERE b.tenant_id = tenant AND b.id = target;
    org := audit_json_uuid(before, after, 'departmentId');
  ELSIF object_type = 'transfer-request' THEN
    scope_object := 'TenantBase.EmploymentRecord';
    employee := audit_json_uuid(before, after, 'employeeId');
    IF employee IS NULL THEN
      -- 调动申请的对象编号即任职业务编号（transfer_requests 以 business_id 为键）
      SELECT b.employee_id INTO employee FROM employment_business_objects b
       WHERE b.tenant_id = tenant AND b.id = target;
    END IF;
    org := audit_json_uuid(before, after, 'departmentId');
  ELSIF object_type = 'employment_employee' THEN
    scope_object := 'TenantBase.Employee';
    employee := target;
  ELSIF object_type IN ('TenantBase.EmployeeInformation', 'personnel-order-code') THEN
    -- 员工信息的对象编号就是员工编号（旧版只存变化字段，前后值里没有 employeeId）
    scope_object := 'TenantBase.EmployeeInformation';
    employee := target;
  ELSIF object_type = 'TenantBase.EmploymentContract' THEN
    scope_object := object_type;
    employee := audit_json_uuid(before, after, 'employeeId');
    IF employee IS NULL THEN
      SELECT c.employee_id INTO employee FROM contract_records c WHERE c.tenant_id = tenant AND c.id = target;
    END IF;
    IF employee IS NULL THEN
      SELECT r.employee_id INTO employee FROM contract_requests r WHERE r.tenant_id = tenant AND r.id = target;
    END IF;
  ELSIF object_type LIKE 'TenantBase.%' THEN
    -- 人员子集与个人信息变更申请：旧版审计只存变化字段，所属人员取同事务写入的 personnel_outbox
    scope_object := object_type;
    employee := audit_json_uuid(before, after, 'employeeId');
    IF employee IS NULL AND target IS NOT NULL THEN
      SELECT o.employee_id INTO employee FROM personnel_outbox o
       WHERE o.tenant_id = tenant AND o.object_type = audit_scope_anchor.object_type AND o.object_id = target
       ORDER BY o.created_at LIMIT 1;
    END IF;
  ELSIF object_type = 'organization' THEN
    scope_object := 'TenantBase.Organization';
    org := target;
  ELSIF object_type = 'org_import_result' THEN
    -- 逐行回执：新写入显式给出（导入的组织 ?? 上级组织）；历史行只能取回执里的组织编号，冲突行推导不出
    scope_object := 'TenantBase.Organization';
    org := audit_json_uuid(before, after, 'orgId');
  ELSIF object_type = 'establishment-capacity' THEN
    scope_object := 'TenantBase.OrganizationEstablishment';
    org := audit_json_uuid(before, after, 'orgId');
    IF org IS NULL THEN
      SELECT o.org_id INTO org FROM establishment_objects o WHERE o.tenant_id = tenant AND o.id = target;
    END IF;
  ELSIF object_type = 'positions' THEN
    scope_object := 'TenantBase.JobPosition';
    org := audit_json_uuid(before, after, 'orgId');
    IF org IS NULL THEN
      SELECT v.org_id INTO org FROM job_position_versions v WHERE v.tenant_id = tenant AND v.object_id = target
       ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1;
    END IF;
  ELSIF object_type IN ('layers', 'grades', 'level-types', 'levels', 'sequences', 'professional-lines', 'posts') THEN
    scope_object := 'TenantBase.' || CASE object_type
      WHEN 'layers' THEN 'JobLayer' WHEN 'grades' THEN 'JobGrade' WHEN 'level-types' THEN 'JobLevelType'
      WHEN 'levels' THEN 'JobLevel' WHEN 'sequences' THEN 'JobSequence'
      WHEN 'professional-lines' THEN 'JobProfessionalLine' ELSE 'JobPost' END;
  ELSIF object_type = 'approval-instance' THEN
    SELECT i.subject_employee_id INTO employee FROM approval_instances i WHERE i.tenant_id = tenant AND i.id = target;
    scope_object := CASE WHEN employee IS NOT NULL THEN 'TenantBase.EmploymentRecord' END;
  ELSIF object_type = 'approval-task' THEN
    SELECT i.subject_employee_id INTO employee FROM approval_tasks t
      JOIN approval_instances i ON i.tenant_id = t.tenant_id AND i.id = t.instance_id
     WHERE t.tenant_id = tenant AND t.id = target;
    scope_object := CASE WHEN employee IS NOT NULL THEN 'TenantBase.EmploymentRecord' END;
  END IF;
  RETURN NEXT;
END $$;
--> statement-breakpoint
-- 6) 统一推导（BEFORE INSERT）：任何写入路径漏填的操作类型、字段差异、归属在这里按同一规则补齐；UUID 对象编号统一
--    小写（P2-4，非 UUID 的复合编号原样保留）；没有请求来源的系统写入记“定时任务”（20 §2、AC-AUD-04）。
CREATE FUNCTION audit_events_derive() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  anchor record;
BEGIN
  IF audit_is_uuid(NEW.object_id) THEN NEW.object_id := lower(NEW.object_id); END IF;
  NEW.operation := COALESCE(NEW.operation, audit_operation_of(NEW.action, NEW.before, NEW.after));
  NEW.changes := COALESCE(NEW.changes, audit_jsonb_diff(NEW.before, NEW.after));
  IF NEW.scope_object IS NULL THEN
    SELECT * INTO anchor FROM audit_scope_anchor(NEW.object_type, NEW.object_id, NEW.before, NEW.after);
    NEW.scope_object := anchor.scope_object;
    NEW.scope_employee_id := COALESCE(NEW.scope_employee_id, anchor.employee);
    NEW.scope_org_id := COALESCE(NEW.scope_org_id, anchor.org);
  END IF;
  IF NEW.actor_user_id IS NULL AND NEW.source_action IS NULL AND NEW.trace_id IS NULL THEN
    NEW.source_action := '定时任务';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION audit_operation_logs_derive() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  anchor record;
BEGIN
  IF audit_is_uuid(NEW.object_id) THEN NEW.object_id := lower(NEW.object_id); END IF;
  IF NEW.scope_object IS NULL THEN
    SELECT * INTO anchor FROM audit_scope_anchor(NEW.object_type, NEW.object_id, NULL, NULL);
    NEW.scope_object := anchor.scope_object;
    NEW.scope_employee_id := COALESCE(NEW.scope_employee_id, anchor.employee);
    NEW.scope_org_id := COALESCE(NEW.scope_org_id, anchor.org);
  END IF;
  IF NEW.actor_user_id IS NULL AND NEW.source_action IS NULL AND NEW.trace_id IS NULL THEN
    NEW.source_action := '定时任务';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 7) DEC-198：新增事件同时写创建人最小元数据（每个对象只留首个），保留期清理不碰它。
CREATE FUNCTION audit_events_record_creator() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.action LIKE '%.create' THEN
    INSERT INTO audit_object_creators (tenant_id, object_type, object_id, action, creator_user_id, created_at)
    VALUES (NEW.tenant_id, NEW.object_type, NEW.object_id, NEW.action, NEW.actor_user_id, NEW.occurred_at)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- 8) 历史行回填（P2-3 / P2-4 / DEC-198）：按租户逐个设置 app.tenant_id（表强制 RLS），并显式按租户过滤
--    （迁移角色若为超级用户会绕过 RLS）。只回填推导列与小写化 UUID 对象编号，不改动前后值；临时卸下只追加触发器。
ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only;
--> statement-breakpoint
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    -- 一次 UPDATE 补齐全部推导列（每行只重写一遍，WAL 与耗时约为分步回填的一半；实测见部署手册 §6）
    UPDATE audit_events a
       SET object_id = CASE WHEN audit_is_uuid(a.object_id) THEN lower(a.object_id) ELSE a.object_id END,
           operation = COALESCE(a.operation, audit_operation_of(a.action, a.before, a.after)),
           changes = COALESCE(a.changes, audit_jsonb_diff(a.before, a.after)),
           (scope_object, scope_employee_id, scope_org_id) = (
             SELECT COALESCE(a.scope_object, s.scope_object), COALESCE(a.scope_employee_id, s.employee),
                    COALESCE(a.scope_org_id, s.org)
               FROM audit_scope_anchor(a.object_type, a.object_id, a.before, a.after) s)
     WHERE a.tenant_id = t.id
       AND (a.operation IS NULL OR a.changes IS NULL OR a.scope_object IS NULL
         OR (audit_is_uuid(a.object_id) AND a.object_id <> lower(a.object_id)));
    INSERT INTO audit_object_creators (tenant_id, object_type, object_id, action, creator_user_id, created_at)
    SELECT DISTINCT ON (e.object_id, e.action, e.object_type)
           e.tenant_id, e.object_type, e.object_id, e.action, e.actor_user_id, e.occurred_at
      FROM audit_events e
     WHERE e.tenant_id = t.id AND e.action LIKE '%.create'
     ORDER BY e.object_id, e.action, e.object_type, e.occurred_at, e.id
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
--> statement-breakpoint
ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only;
--> statement-breakpoint
CREATE TRIGGER audit_events_derive BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_derive();
--> statement-breakpoint
CREATE TRIGGER audit_events_creator AFTER INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_record_creator();
--> statement-breakpoint
CREATE TRIGGER audit_operation_logs_derive BEFORE INSERT ON audit_operation_logs
  FOR EACH ROW EXECUTE FUNCTION audit_operation_logs_derive();
--> statement-breakpoint
-- 9) 按租户保留期清理（20 §5 第 4 条，DEC-198，P2-2）：
--    - 只授予平台角色（定时清理经平台路径运行），业务角色不能调用；
--    - 保留月数在函数内读取租户配置 audit.retention（激活覆盖 ?? 系统值；不合法回落 6 个月，与 domain 一致），
--      调用方无法缩短；“现在”取调用方时钟与库时钟较早者，传入未来时间也不能提前清理；
--    - 到期整条清理（首个新增事件不例外，创建人元数据另存于 audit_object_creators）；
--    - 分批：每次每表最多删 p_batch 行，返回 remaining 由调用方续跑（每批一个事务）；锁等待 5 秒超时；
--    - 本批有删除时在同一事务写一条「日志清理」对象操作日志（操作人“系统”、来源动作“定时任务”）。
CREATE FUNCTION purge_expired_audit(p_tenant uuid, p_now timestamptz, p_batch integer, p_command_id text DEFAULT NULL)
  RETURNS TABLE (cutoff date, retain_months integer, data_changes integer, operation_logs integer,
    command_failures integer, remaining boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  tz text;
  setting jsonb;
  boundary timestamptz;
  ran_at timestamptz := LEAST(coalesce(p_now, now()), now());
  total integer;
BEGIN
  IF current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'purge_expired_audit 只能经平台路径调用' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 100000 THEN
    RAISE EXCEPTION '单批清理量须为 1～100000' USING ERRCODE = 'check_violation';
  END IF;
  SELECT t.timezone INTO tz FROM tenants t WHERE t.id = p_tenant;
  IF tz IS NULL THEN
    RAISE EXCEPTION '租户不存在' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  PERFORM set_config('lock_timeout', '5s', true);
  SELECT COALESCE(
      (SELECT o.value FROM tenant_setting_overrides o
        WHERE o.tenant_id = p_tenant AND o.key = 'audit.retention' AND o.active),
      (SELECT s.value FROM system_settings s WHERE s.key = 'audit.retention'))
    INTO setting;
  retain_months := CASE
    WHEN jsonb_typeof(setting -> 'retainMonths') = 'number' AND (setting ->> 'retainMonths') ~ '^[0-9]+$'
      AND (setting ->> 'retainMonths')::numeric BETWEEN 1 AND 120
      THEN (setting ->> 'retainMonths')::integer
    ELSE 6 END;
  cutoff := ((ran_at AT TIME ZONE tz)::date - make_interval(months => retain_months))::date;
  boundary := cutoff::timestamp AT TIME ZONE tz;
  PERFORM set_config('italent.audit_purge', 'on', true);
  DELETE FROM audit_events WHERE id IN (SELECT a.id FROM audit_events a
    WHERE a.tenant_id = p_tenant AND a.occurred_at < boundary ORDER BY a.occurred_at LIMIT p_batch);
  GET DIAGNOSTICS data_changes = ROW_COUNT;
  DELETE FROM audit_operation_logs WHERE id IN (SELECT o.id FROM audit_operation_logs o
    WHERE o.tenant_id = p_tenant AND o.occurred_at < boundary ORDER BY o.occurred_at LIMIT p_batch);
  GET DIAGNOSTICS operation_logs = ROW_COUNT;
  DELETE FROM audit_command_failures WHERE id IN (SELECT f.id FROM audit_command_failures f
    WHERE f.tenant_id = p_tenant AND f.occurred_at < boundary ORDER BY f.occurred_at LIMIT p_batch);
  GET DIAGNOSTICS command_failures = ROW_COUNT;
  PERFORM set_config('italent.audit_purge', 'off', true);
  total := data_changes + operation_logs + command_failures;
  IF total > 0 THEN
    INSERT INTO audit_operation_logs (tenant_id, actor_user_id, behavior, object_type, summary, total_count,
      success_count, failure_count, result, command_id, occurred_at, source_action)
    VALUES (p_tenant, NULL, 'purge', 'audit_retention',
      format('清理 %s 之前的日志 %s 条（保留 %s 个月）', cutoff, total, retain_months),
      total, total, 0, 'succeeded', p_command_id, ran_at, '定时任务');
  END IF;
  remaining := EXISTS (SELECT 1 FROM audit_events a WHERE a.tenant_id = p_tenant AND a.occurred_at < boundary)
    OR EXISTS (SELECT 1 FROM audit_operation_logs o WHERE o.tenant_id = p_tenant AND o.occurred_at < boundary)
    OR EXISTS (SELECT 1 FROM audit_command_failures f WHERE f.tenant_id = p_tenant AND f.occurred_at < boundary);
  PERFORM set_config('app.tenant_id', '', true);
  RETURN NEXT;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION purge_expired_audit(uuid, timestamptz, integer, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_expired_audit(uuid, timestamptz, integer, text) TO app_platform;
