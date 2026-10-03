-- PR #35 第二轮：审批中心的数据库层约束（与 0027 的表结构变更配套）。
-- DEC-098：异常管理员停用前必须指定替代人——仍是可用流程（当前生效版本）的异常管理员时，不允许撤销其成员关系。
-- 平台撤销成员关系在租户上下文（app_user + app.tenant_id）内执行，触发器按 RLS 只看本租户流程。
CREATE FUNCTION approval_guard_exception_admin_revoke() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active' AND EXISTS (
    SELECT 1 FROM approval_processes p
    JOIN approval_process_versions v ON v.tenant_id = p.tenant_id AND v.id = p.current_version_id
    WHERE p.tenant_id = NEW.tenant_id AND p.status = 'active' AND v.exception_admin_user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION '该成员是审批流程的异常管理员，请先在审批中心指定替代人'
      USING ERRCODE = 'P0001', HINT = 'APPROVAL_EXCEPTION_ADMIN_HANDOVER_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "approval_guard_exception_admin_revoke" BEFORE UPDATE OF "status" ON "tenant_memberships"
  FOR EACH ROW EXECUTE FUNCTION approval_guard_exception_admin_revoke();
--> statement-breakpoint
-- DEC-097 抄送记录、DEC-099 员工信息变更申请版本：租户隔离 + 只追加（应用角色只有查询与新增权限）。
SELECT enable_tenant_isolation('approval_instance_ccs');
--> statement-breakpoint
GRANT SELECT, INSERT ON "approval_instance_ccs" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_change_request_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_change_request_versions" TO app_user;
--> statement-breakpoint
-- DEC-123：异常管理员交接指定的替代人（停用时自动转派剩余异常待办用）：租户隔离；交接时新增或改写。
SELECT enable_tenant_isolation('approval_exception_admin_successors');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "approval_exception_admin_successors" TO app_user;
