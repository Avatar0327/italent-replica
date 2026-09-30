-- 手写迁移：多租户隔离（R1-T00，硬规则 7；docs/08_设计/R1-T00_多租户底座设计.md §2–§3）。
-- 1) 两个非超级用户、无 BYPASSRLS、不可登录的角色：
--    app_user     —— 租户路径（withTenant），只能碰带 tenant_id 且受 RLS 约束的表，另可只读 system_settings；
--    app_platform —— 平台路径（withPlatform），只能碰平台级表，对租户数据表没有任何权限。
--    角色是集群级对象：已存在时跳过（真 PG 测试会在同一集群并行建多个库；非超级用户的迁移角色
--    无权建角色时，须由 DBA 预建，见 scripts/dev-db.sh）。连接角色须是这两个角色的成员才能 SET ROLE
--    （CI 用超级用户，天然满足；生产部署步骤见设计文档 §6）。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_platform') THEN
    CREATE ROLE app_platform NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_user, app_platform;
--> statement-breakpoint

-- 2) 当前租户：未设置或为空时返回 NULL，策略比较结果为 NULL → 读不到、写不进（fail-closed）。
--    非法 UUID 文本会在转换时报错，同样不会放行。
CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint

-- 3) 给一张带 tenant_id 的表加上统一的隔离策略。后续模块的新表在各自迁移里调用：
--    SELECT enable_tenant_isolation('xxx'); 再单独 GRANT 所需权限给 app_user。
CREATE FUNCTION enable_tenant_isolation(target regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = current_tenant_id()) '
    'WITH CHECK (tenant_id = current_tenant_id())',
    target
  );
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION enable_tenant_isolation(regclass) FROM PUBLIC;
--> statement-breakpoint
SELECT enable_tenant_isolation('tenant_memberships');
--> statement-breakpoint
SELECT enable_tenant_isolation('tenant_setting_overrides');
--> statement-breakpoint
SELECT enable_tenant_isolation('audit_events');
--> statement-breakpoint
SELECT enable_tenant_isolation('command_ledger');
--> statement-breakpoint
-- M0 示例表也带 tenant_id，一并纳入（守卫测试要求所有带 tenant_id 的表都强制 RLS）
SELECT enable_tenant_isolation('m0_demo_validity');
--> statement-breakpoint

-- 4) 最小权限
GRANT SELECT, INSERT, UPDATE ON tenant_memberships TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_setting_overrides TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_events TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON command_ledger TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON m0_demo_validity TO app_user;
--> statement-breakpoint
GRANT SELECT ON system_settings TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON tenants, users, system_settings, platform_meta TO app_platform;
--> statement-breakpoint

-- 5) 租户时区只接受 IANA 名（DEC-056），与 packages/domain/src/tenant-time.ts 的校验一致
CREATE FUNCTION is_valid_iana_timezone(tz text) RETURNS boolean
  LANGUAGE plpgsql STABLE
  AS $$
BEGIN
  IF tz IS NULL OR tz !~ '^(UTC|[A-Z][A-Za-z_]*(/[A-Za-z0-9_+-]+)+)$' THEN
    RETURN false;
  END IF;
  PERFORM now() AT TIME ZONE tz;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;
--> statement-breakpoint
ALTER TABLE tenants ADD CONSTRAINT tenants_timezone_valid CHECK (is_valid_iana_timezone(timezone));
--> statement-breakpoint

-- 6) 审计只追加：语句级触发器，对任何角色（含表属主、超级用户）拒绝 UPDATE / DELETE / TRUNCATE
CREATE FUNCTION forbid_audit_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'audit_events 只允许追加，拒绝 %', TG_OP USING ERRCODE = 'object_not_in_prerequisite_state';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint

-- 7) 系统级预置：日志保留期（docs/02_业务建模/20 §5 第 4 条：原站“查询 3 个月、保留 6 个月”，复刻做成租户可覆盖）
INSERT INTO system_settings (key, value, description, overridable)
VALUES ('audit.retention', '{"queryMonths": 3, "retainMonths": 6}', '日志查询期与保留期（月）', true)
ON CONFLICT (key) DO NOTHING;
