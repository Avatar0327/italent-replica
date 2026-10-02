-- R1-T05：所有任职表强制租户隔离；业务快照仅追加。
SELECT enable_tenant_isolation('employment_employees');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_cycles');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_business_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_payload_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_state_events');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_records');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_record_tombstones');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_timeline');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_outbox');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_outbox_attempts');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_custom_field_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_custom_field_inheritance_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_settings');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_setting_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON
  employment_employees, employment_cycles, employment_business_objects,
  employment_payload_versions, employment_state_events, employment_records,
  employment_record_tombstones, employment_timeline,
  employment_outbox, employment_outbox_attempts, employment_custom_field_objects,
  employment_custom_field_inheritance_versions, employment_settings,
  employment_setting_versions TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON employment_employees TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON employment_business_objects TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON employment_custom_field_objects TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON employment_settings TO app_user;
--> statement-breakpoint
GRANT UPDATE (valid_during), DELETE ON employment_timeline TO app_user;
--> statement-breakpoint
CREATE TRIGGER employment_cycles_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON employment_cycles
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER employment_payload_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON employment_payload_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER employment_state_events_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON employment_state_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER employment_records_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON employment_records
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER employment_record_tombstones_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON employment_record_tombstones
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER employment_outbox_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON employment_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER employment_outbox_attempts_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON employment_outbox_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER employment_custom_field_inheritance_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON employment_custom_field_inheritance_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER employment_setting_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON employment_setting_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
-- 即使由迁移所有者连接，也不能把稳定头的业务标识改写成另一对象。
CREATE FUNCTION protect_employment_head_metadata() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (to_jsonb(NEW) - 'revision') IS DISTINCT FROM (to_jsonb(OLD) - 'revision') THEN
    RAISE EXCEPTION 'employment identity fields are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER employment_employees_metadata_only
  BEFORE UPDATE ON employment_employees
  FOR EACH ROW EXECUTE FUNCTION protect_employment_head_metadata();
--> statement-breakpoint
CREATE TRIGGER employment_business_objects_metadata_only
  BEFORE UPDATE ON employment_business_objects
  FOR EACH ROW EXECUTE FUNCTION protect_employment_head_metadata();
--> statement-breakpoint
CREATE TRIGGER employment_custom_field_objects_metadata_only
  BEFORE UPDATE ON employment_custom_field_objects
  FOR EACH ROW EXECUTE FUNCTION protect_employment_head_metadata();
--> statement-breakpoint
CREATE TRIGGER employment_settings_metadata_only
  BEFORE UPDATE ON employment_settings
  FOR EACH ROW EXECUTE FUNCTION protect_employment_head_metadata();
--> statement-breakpoint
CREATE TRIGGER employment_employees_no_removal
  BEFORE DELETE OR TRUNCATE ON employment_employees
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER employment_business_objects_no_removal
  BEFORE DELETE OR TRUNCATE ON employment_business_objects
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER employment_custom_field_objects_no_removal
  BEFORE DELETE OR TRUNCATE ON employment_custom_field_objects
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER employment_settings_no_removal
  BEFORE DELETE OR TRUNCATE ON employment_settings
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE FUNCTION protect_employment_projection_metadata() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (to_jsonb(NEW) - 'valid_during') IS DISTINCT FROM (to_jsonb(OLD) - 'valid_during') THEN
    RAISE EXCEPTION 'only employment projection range may change' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER employment_timeline_metadata_only
  BEFORE UPDATE ON employment_timeline
  FOR EACH ROW EXECUTE FUNCTION protect_employment_projection_metadata();
--> statement-breakpoint
CREATE TRIGGER employment_timeline_no_truncate
  BEFORE TRUNCATE ON employment_timeline
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
-- 日期投影允许在同一事务内先缩短旧区间，再插入补录区间。
ALTER TABLE employment_timeline
  ADD CONSTRAINT employment_timeline_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, valid_during WITH &&)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
-- 不依赖数据库主机的 current_date；覆盖从首条有效记录至无穷日期。
-- 租户业务日由读取端传入 @>，未来记录无需午夜改写 current 标志。
CREATE FUNCTION verify_employment_timeline_coverage() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  checked_tenant uuid;
  checked_employee uuid;
  active_count bigint;
  projection_count bigint;
  earliest_start date;
  actual_coverage datemultirange;
BEGIN
  IF TG_OP = 'DELETE' THEN
    checked_tenant := OLD.tenant_id;
    checked_employee := OLD.employee_id;
  ELSE
    checked_tenant := NEW.tenant_id;
    checked_employee := NEW.employee_id;
  END IF;

  -- 服务通常已持锁；约束本身也串行检查，防止绕过服务的并发写产生不完整时间轴。
  PERFORM 1 FROM public.employment_employees
    WHERE tenant_id = checked_tenant AND id = checked_employee FOR UPDATE;

  SELECT count(*), min(r.start_date) INTO active_count, earliest_start
    FROM public.employment_records r
    WHERE r.tenant_id = checked_tenant AND r.employee_id = checked_employee
      AND NOT EXISTS (
        SELECT 1 FROM public.employment_record_tombstones d
        WHERE d.tenant_id = r.tenant_id AND d.record_id = r.id
      );

  SELECT count(*), range_agg(p.valid_during) INTO projection_count, actual_coverage
    FROM public.employment_timeline p
    WHERE p.tenant_id = checked_tenant AND p.employee_id = checked_employee;

  -- 投影主键与复合 FK 已保证每个投影仅对应一条同员工、同日期的业务记录。
  IF active_count <> projection_count OR EXISTS (
    SELECT 1 FROM public.employment_timeline p
    JOIN public.employment_record_tombstones d
      ON d.tenant_id = p.tenant_id AND d.record_id = p.record_id
    WHERE p.tenant_id = checked_tenant AND p.employee_id = checked_employee
  ) THEN
    RAISE EXCEPTION 'every active employment record requires one projection'
      USING ERRCODE = '23514', CONSTRAINT = 'employment_timeline_complete';
  END IF;

  IF active_count > 0 AND actual_coverage IS DISTINCT FROM
      datemultirange(daterange(earliest_start, NULL, '[)')) THEN
    RAISE EXCEPTION 'employment timeline must cover continuously through infinity'
      USING ERRCODE = '23514', CONSTRAINT = 'employment_timeline_complete';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER employment_records_complete_timeline
  AFTER INSERT ON employment_records
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_employment_timeline_coverage();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER employment_timeline_complete
  AFTER INSERT OR UPDATE OR DELETE ON employment_timeline
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_employment_timeline_coverage();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER employment_tombstones_complete_timeline
  AFTER INSERT ON employment_record_tombstones
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_employment_timeline_coverage();
