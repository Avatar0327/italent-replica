-- 手写迁移：F-328 / DEC-707 重聘（合并人员）时登录用户名改为员工联系邮箱（docs/02_业务建模/30「F-328」节）。
-- 全局账号表只有平台角色可写；租户路径经本函数改且只改“绑定本租户人员”的账号。
-- 账号同时是其他租户成员（任何状态）时不改：全局登录名是各租户共用的，不能由一个租户的重聘改掉（结果 'shared'）。
-- 成员关系表强制 RLS，按租户逐个设置 app.tenant_id 判定（同 0033），并显式按租户过滤（属主若为超级用户会绕过 RLS），
-- 判定后恢复为调用方租户。与他人登录名冲突时 UPDATE 抛唯一约束错误（23505），由调用方按 EMAIL_TAKEN 整单回滚。
CREATE FUNCTION tenant_rehire_login_email(p_user uuid, p_email text, p_actor uuid, p_command_id text)
  RETURNS TABLE (outcome text, before_email text, after_email text, revision integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  caller uuid := current_tenant_id();
  normalized text := lower(btrim(p_email));
  account users%ROWTYPE;
  other record;
  shared boolean := false;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'tenant_rehire_login_email 只能在租户上下文中调用' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permission_user_person_links l WHERE l.tenant_id = caller AND l.user_id = p_user) THEN
    RAISE EXCEPTION '账号未绑定本租户人员' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO account FROM users u WHERE u.id = p_user FOR NO KEY UPDATE;
  -- 联系邮箱是档案自由文本（导入可能带入不合法值）：不能作登录名时保持原登录名，不让重聘失败（结果 'invalid'）
  IF normalized IS NULL OR normalized !~ '^[^@[:space:]]+@[^@[:space:]]+$' THEN
    RETURN QUERY SELECT 'invalid'::text, account.email, account.email, account.revision;
    RETURN;
  END IF;
  IF account.email = normalized THEN
    RETURN QUERY SELECT 'unchanged'::text, account.email, account.email, account.revision;
    RETURN;
  END IF;
  FOR other IN SELECT t.id FROM tenants t WHERE t.id <> caller ORDER BY t.id LOOP
    PERFORM set_config('app.tenant_id', other.id::text, true);
    shared := EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = other.id AND m.user_id = p_user);
    EXIT WHEN shared;
  END LOOP;
  PERFORM set_config('app.tenant_id', caller::text, true);
  IF shared THEN
    RETURN QUERY SELECT 'shared'::text, account.email, account.email, account.revision;
    RETURN;
  END IF;
  UPDATE users SET email = normalized, revision = account.revision + 1, updated_at = now() WHERE id = p_user;
  INSERT INTO platform_audit_events (actor_user_id, action, object_type, object_id, before, after, command_id)
  VALUES (p_actor, 'user.change_email', 'user', p_user::text,
    jsonb_build_object('email', account.email, 'displayName', account.display_name, 'status', account.status,
      'revision', account.revision),
    jsonb_build_object('email', normalized, 'displayName', account.display_name, 'status', account.status,
      'revision', account.revision + 1, 'source', 'tenant_rehire', 'tenantId', caller),
    p_command_id);
  RETURN QUERY SELECT 'changed'::text, account.email, normalized, account.revision + 1;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION tenant_rehire_login_email(uuid, text, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenant_rehire_login_email(uuid, text, uuid, text) TO app_user;
--> statement-breakpoint
-- 当天重聘在重聘事务内启用由离职停用的账号（F-328 返工 P1-1）：启用与改名、任职链、账号任务同一提交边界，
-- 启用写入失败时整单回滚。只启用“绑定本租户人员、仍处于本规则停用后 revision、且不是其他租户成员”的账号；
-- 不满足时不动账号（'shared' / 'kept'），由调用方交回提交后的全局协调（setUserStatus）。
-- 锁序同改名：重聘事务已持员工锁，再锁账号行 FOR NO KEY UPDATE；停用路径同样先预锁员工再锁账号行。
CREATE FUNCTION tenant_rehire_enable_account(p_user uuid, p_expected_revision integer, p_actor uuid,
    p_command_id text)
  RETURNS TABLE (outcome text, revision integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  caller uuid := current_tenant_id();
  account users%ROWTYPE;
  other record;
  shared boolean := false;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'tenant_rehire_enable_account 只能在租户上下文中调用' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permission_user_person_links l WHERE l.tenant_id = caller AND l.user_id = p_user) THEN
    RAISE EXCEPTION '账号未绑定本租户人员' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO account FROM users u WHERE u.id = p_user FOR NO KEY UPDATE;
  IF account.status <> 'disabled' OR account.revision <> p_expected_revision THEN
    RETURN QUERY SELECT 'kept'::text, account.revision;
    RETURN;
  END IF;
  FOR other IN SELECT t.id FROM tenants t WHERE t.id <> caller ORDER BY t.id LOOP
    PERFORM set_config('app.tenant_id', other.id::text, true);
    shared := EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = other.id AND m.user_id = p_user);
    EXIT WHEN shared;
  END LOOP;
  PERFORM set_config('app.tenant_id', caller::text, true);
  IF shared THEN
    RETURN QUERY SELECT 'shared'::text, account.revision;
    RETURN;
  END IF;
  UPDATE users SET status = 'active', revision = account.revision + 1, updated_at = now() WHERE id = p_user;
  INSERT INTO platform_audit_events (actor_user_id, action, object_type, object_id, before, after, command_id)
  VALUES (p_actor, 'user.set_status', 'user', p_user::text,
    jsonb_build_object('email', account.email, 'displayName', account.display_name, 'status', account.status,
      'revision', account.revision),
    jsonb_build_object('email', account.email, 'displayName', account.display_name, 'status', 'active',
      'revision', account.revision + 1, 'source', 'tenant_rehire', 'tenantId', caller),
    p_command_id);
  RETURN QUERY SELECT 'enabled'::text, account.revision + 1;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION tenant_rehire_enable_account(uuid, integer, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenant_rehire_enable_account(uuid, integer, uuid, text) TO app_user;
