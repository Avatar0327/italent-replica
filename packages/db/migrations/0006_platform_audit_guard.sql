-- 手写迁移：平台审计与平台命令台账的权限与只追加约束（R1-T00，docs/08_设计/R1-T00_多租户底座设计.md §3）。
-- 两表不含 tenant_id、不受 RLS 约束，只授予平台角色；app_user 无任何权限。
GRANT SELECT, INSERT ON platform_audit_events, platform_command_ledger TO app_platform;
--> statement-breakpoint
-- 提示信息带上表名，供多张只追加表共用（替换 0003 中的同名函数，不改 0003）
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% 只允许追加，拒绝 %', TG_TABLE_NAME, TG_OP USING ERRCODE = 'object_not_in_prerequisite_state';
END $$;
--> statement-breakpoint
CREATE TRIGGER platform_audit_events_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON platform_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
