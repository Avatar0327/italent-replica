-- F-493 S1：员工工号与账号登录名可空（设计 §3.5 / §4.1）。
-- 先收紧开通函数：登录名不再靠列 NOT NULL 兜底，函数自己拒绝空 / 非法登录名（check_violation，与原行为同码），
-- 再放开两列。UNIQUE(email)、users_email_lowercase、lower(code) 唯一索引和 employment_employees_code_nonempty 都保留：
-- NULL 在唯一索引里互不相等，CHECK 对 NULL 计算为 NULL 即通过；全空白仍被拒绝。
CREATE OR REPLACE FUNCTION tenant_provision_account(p_email text, p_display_name text, p_actor uuid, p_command_id text)
  RETURNS TABLE (account_id uuid, created boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  normalized text := lower(btrim(p_email));
  inserted uuid;
BEGIN
  IF current_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'tenant_provision_account 只能在租户上下文中调用' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF normalized IS NULL OR normalized !~ '^[^@[:space:]]+@[^@[:space:]]+$'
    OR btrim(coalesce(p_display_name, '')) = '' THEN
    RAISE EXCEPTION '登录邮箱或姓名不合法' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO users (email, display_name) VALUES (normalized, btrim(p_display_name))
    ON CONFLICT (email) DO NOTHING
    RETURNING id INTO inserted;
  IF inserted IS NOT NULL THEN
    INSERT INTO platform_audit_events (actor_user_id, action, object_type, object_id, before, after, command_id)
    VALUES (p_actor, 'user.create', 'user', inserted::text, NULL,
      jsonb_build_object('email', normalized, 'displayName', btrim(p_display_name), 'status', 'active',
        'revision', 1, 'source', 'tenant_provision'),
      p_command_id);
  END IF;
  RETURN QUERY SELECT u.id, inserted IS NOT NULL FROM users u WHERE u.email = normalized FOR SHARE;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION tenant_provision_account(text, text, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenant_provision_account(text, text, uuid, text) TO app_user;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "employment_employees" ALTER COLUMN "code" DROP NOT NULL;
