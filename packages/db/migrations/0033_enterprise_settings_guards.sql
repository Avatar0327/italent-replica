-- R1-T15 企业设置：用户管理（DEC-128）与权限模块 outbox 的数据库层约束。
-- 1) 权限模块 outbox：租户隔离；应用角色可新增、读取，消费者按游标更新投递状态。
SELECT enable_tenant_isolation('permission_outbox');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "permission_outbox" TO app_user;
--> statement-breakpoint
-- 2) DEC-128：建档 / 入职时在租户事务内按登录邮箱找到或新建全局账号。应用角色 app_user 不能读写平台用户表，
--    定义者权限只用于这一件事：只能在已设置租户上下文时调用；只返回账号编号与“是否新建”，不返回账号的其他信息，
--    不能借此探测他租户的成员关系；新建时同事务写平台审计；以 FOR SHARE 锁住 users 行，与全局停用账号
--    （NO KEY UPDATE）串行，停用期间该账号不会在任何租户新变成有效成员（与 grantMembership 同一协议，R1-T07 R5-2）。
CREATE FUNCTION tenant_provision_account(p_email text, p_display_name text, p_actor uuid, p_command_id text)
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
  IF normalized !~ '^[^@[:space:]]+@[^@[:space:]]+$' OR btrim(coalesce(p_display_name, '')) = '' THEN
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
-- 3) 用户管理列表显示本租户成员的登录邮箱、姓名与账号状态（DEC-128：账号启用状态与在职状态分别记录）。
--    只回答当前租户成员（含已移出的）的账号；不是本租户成员的账号一律不返回。成员关系显式按当前租户过滤
--    （属主是超级用户时不受 RLS 约束，不能只靠策略）。
CREATE FUNCTION tenant_member_accounts(targets uuid[])
  RETURNS TABLE (account_id uuid, email text, display_name text, status text, revision integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.email, u.display_name, u.status, u.revision FROM users u
    WHERE u.id = ANY(targets) AND EXISTS (
      SELECT 1 FROM tenant_memberships m WHERE m.user_id = u.id AND m.tenant_id = current_tenant_id()
    )
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION tenant_member_accounts(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenant_member_accounts(uuid[]) TO app_user;
--> statement-breakpoint
-- 4) DEC-128：用户与人员一一对应、不能改绑。绑定只由建档 / 入职新增，应用角色不再有 UPDATE 权限；
--    （DELETE 仍保留给 0019 的既有用途，如审批测试模拟“账号解绑”；应用接口已不提供解绑入口。）
REVOKE UPDATE ON "permission_user_person_links" FROM app_user;
--> statement-breakpoint
-- 5) 外部用户没有人员档案：登记为外部用户的成员不能绑定档案；已绑定档案的成员不能改登记为外部用户。
CREATE FUNCTION guard_person_link_internal() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_memberships m
    WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id AND m.user_type = 'external') THEN
    RAISE EXCEPTION '外部用户没有人员档案，不能绑定' USING ERRCODE = 'P0001', HINT = 'EXTERNAL_USER_HAS_NO_PROFILE';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "permission_person_links_internal_only" BEFORE INSERT ON "permission_user_person_links"
  FOR EACH ROW EXECUTE FUNCTION guard_person_link_internal();
--> statement-breakpoint
CREATE FUNCTION guard_member_external_unlinked() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.user_type = 'external' AND EXISTS (SELECT 1 FROM permission_user_person_links l
    WHERE l.tenant_id = NEW.tenant_id AND l.user_id = NEW.user_id) THEN
    RAISE EXCEPTION '已绑定人员档案的用户不能登记为外部用户' USING ERRCODE = 'P0001', HINT = 'USER_TYPE_LOCKED';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "tenant_memberships_external_unlinked" BEFORE INSERT OR UPDATE OF "user_type" ON "tenant_memberships"
  FOR EACH ROW EXECUTE FUNCTION guard_member_external_unlinked();
--> statement-breakpoint
-- 6) DEC-141：撤销已消耗许可的身份时归还名额（删除占用），仍持有同类授权时占用改记到仍有效的授权（更新 grant_id）。
GRANT UPDATE, DELETE ON "license_seats" TO app_user;
--> statement-breakpoint
-- 7) DEC-141 升级对账：旧版“撤销授权不归还名额”，历史数据里可能留有指向已撤销授权的占用，升级后仍计入已用。
--    该用户仍持有同类有效授权的，占用改记到最早的那条有效授权（与 licenses.ts releaseSeat 同一口径）；否则释放。
--    表强制 RLS，按租户逐个设置 app.tenant_id 执行（同 0027），并显式按租户过滤（迁移角色若为超级用户会绕过 RLS）。
--    每条变更同事务写审计（操作者为空 = 系统）与 outbox，释放的占用在审计里保留快照（AGENTS.md §5、§10）。
DO $$
DECLARE
  t record;
  s record;
  seat jsonb;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    FOR s IN
      SELECT ls.license_type, ls.user_id, ls.grant_id, ls.consumed_at, successor.id AS successor_id
        FROM license_seats ls
        LEFT JOIN LATERAL (
          SELECT g.id FROM permission_grants g
            JOIN permission_profiles p ON p.tenant_id = g.tenant_id AND p.id = g.profile_id
           WHERE g.tenant_id = ls.tenant_id AND g.user_id = ls.user_id AND g.status = 'active'
             AND p.license_type = ls.license_type
           ORDER BY g.created_at, g.id
           LIMIT 1
        ) successor ON true
       WHERE ls.tenant_id = t.id AND NOT EXISTS (
         SELECT 1 FROM permission_grants held
          WHERE held.tenant_id = ls.tenant_id AND held.id = ls.grant_id AND held.status = 'active')
       ORDER BY ls.license_type, ls.user_id
    LOOP
      seat := jsonb_build_object('licenseType', s.license_type, 'userId', s.user_id, 'grantId', s.grant_id,
        'consumedAt', s.consumed_at);
      IF s.successor_id IS NOT NULL THEN
        UPDATE license_seats SET grant_id = s.successor_id
         WHERE tenant_id = t.id AND license_type = s.license_type AND user_id = s.user_id;
      ELSE
        DELETE FROM license_seats WHERE tenant_id = t.id AND license_type = s.license_type AND user_id = s.user_id;
      END IF;
      INSERT INTO audit_events (tenant_id, actor_user_id, action, object_type, object_id, before, after, command_id)
      VALUES (t.id, NULL,
        CASE WHEN s.successor_id IS NULL THEN 'license_seat.release' ELSE 'license_seat.reassign' END,
        'license_seat', s.license_type || ':' || s.user_id, seat,
        CASE WHEN s.successor_id IS NULL THEN NULL ELSE seat || jsonb_build_object('grantId', s.successor_id) END,
        'migration:license-seat-reconcile');
      INSERT INTO permission_outbox (tenant_id, object_type, object_id, event_type, command_id)
      VALUES (t.id, 'license_seat', s.license_type || ':' || s.user_id,
        CASE WHEN s.successor_id IS NULL THEN 'license_seat.release' ELSE 'license_seat.reassign' END,
        'migration:license-seat-reconcile');
    END LOOP;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
