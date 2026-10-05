-- 手写迁移：DEC-147（docs/02_业务建模/10 §18）组织「编辑」更正设立日期时首版生效日随之变化，是组织版本唯一允许的原地更正。
-- 只放行 start_date / established_on 两列，且须在本事务内先声明 italent.org_correction = 'established_on'；
-- 删除、清空与其余列的改写仍一律拒绝。更正前后的值由业务事务同时写入审计（DEC-019）。
-- 语句级闸门保证未声明时任何 UPDATE 都被拒（即使一行也没碰到，数据库属主也一样），行级触发器再逐行核对只改了这两列。
DROP TRIGGER org_versions_append_only ON org_versions;
--> statement-breakpoint
CREATE TRIGGER org_versions_append_only
  BEFORE DELETE OR TRUNCATE ON org_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE FUNCTION org_versions_correction_gate() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF COALESCE(current_setting('italent.org_correction', true), '') <> 'established_on' THEN
    RAISE EXCEPTION 'org_versions 只允许追加；仅「编辑」设立日期可更正 start_date / established_on'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER org_versions_correction_gate
  BEFORE UPDATE ON org_versions
  FOR EACH STATEMENT EXECUTE FUNCTION org_versions_correction_gate();
--> statement-breakpoint
CREATE FUNCTION org_versions_correction_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - 'start_date' - 'established_on') IS DISTINCT FROM (to_jsonb(OLD) - 'start_date' - 'established_on')
  THEN
    RAISE EXCEPTION 'org_versions 只允许追加；仅「编辑」设立日期可更正 start_date / established_on'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER org_versions_correction_only
  BEFORE UPDATE ON org_versions
  FOR EACH ROW EXECUTE FUNCTION org_versions_correction_only();
--> statement-breakpoint
GRANT UPDATE (start_date, established_on) ON org_versions TO app_user;
