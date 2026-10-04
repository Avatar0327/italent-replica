-- R1-T07：审批表强制租户隔离；已发布流程版本及其节点 / 条件 / 消息规则只读（REQ-APV-001 R1）；
-- 实例的版本绑定不可改（实例冻结发起时版本，R3）；实例日志只追加；审批详情页显示原信息开关（`14` §6.1 开关 94）。
SELECT enable_tenant_isolation('approval_processes');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "approval_processes" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('approval_process_versions');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "approval_process_versions" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('approval_process_conditions');
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "approval_process_conditions" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('approval_process_nodes');
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "approval_process_nodes" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('approval_node_message_rules');
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "approval_node_message_rules" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('approval_instances');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "approval_instances" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('approval_tasks');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "approval_tasks" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('approval_instance_logs');
--> statement-breakpoint
GRANT SELECT, INSERT ON "approval_instance_logs" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "approval_instance_logs_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "approval_instance_logs" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('approval_notifications');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "approval_notifications" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('approval_outbox');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "approval_outbox" TO app_user;
--> statement-breakpoint
CREATE FUNCTION approval_version_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '流程版本不可删除' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION '已发布的流程版本不可修改，请编辑最新版本' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.process_id <> OLD.process_id OR NEW.version_no <> OLD.version_no THEN
    RAISE EXCEPTION '流程版本归属不可修改' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "approval_versions_published_immutable" BEFORE UPDATE OR DELETE
  ON "approval_process_versions" FOR EACH ROW EXECUTE FUNCTION approval_version_guard();
--> statement-breakpoint
CREATE FUNCTION approval_version_child_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  target_tenant uuid;
  target_version uuid;
  version_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_version := OLD.version_id;
  ELSE
    target_tenant := NEW.tenant_id;
    target_version := NEW.version_id;
  END IF;
  SELECT status INTO version_status FROM approval_process_versions
    WHERE tenant_id = target_tenant AND id = target_version;
  IF version_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION '已发布流程版本的节点与条件不可修改' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "approval_conditions_draft_only" BEFORE INSERT OR UPDATE OR DELETE
  ON "approval_process_conditions" FOR EACH ROW EXECUTE FUNCTION approval_version_child_guard();
--> statement-breakpoint
CREATE TRIGGER "approval_nodes_draft_only" BEFORE INSERT OR UPDATE OR DELETE
  ON "approval_process_nodes" FOR EACH ROW EXECUTE FUNCTION approval_version_child_guard();
--> statement-breakpoint
CREATE TRIGGER "approval_message_rules_draft_only" BEFORE INSERT OR UPDATE OR DELETE
  ON "approval_node_message_rules" FOR EACH ROW EXECUTE FUNCTION approval_version_child_guard();
--> statement-breakpoint
CREATE FUNCTION approval_instance_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.process_id <> OLD.process_id OR NEW.version_id <> OLD.version_id
    OR NEW.business_type <> OLD.business_type OR NEW.business_id <> OLD.business_id
    OR NEW.initiator_user_id <> OLD.initiator_user_id THEN
    RAISE EXCEPTION '审批实例的流程版本与业务归属不可修改' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "approval_instances_frozen" BEFORE UPDATE
  ON "approval_instances" FOR EACH ROW EXECUTE FUNCTION approval_instance_guard();
--> statement-breakpoint
INSERT INTO system_settings(key,value,description,overridable,version,updated_at)
VALUES ('approval.show_original_values','true'::jsonb,'审批详情页显示原信息（变更前原值）',true,1,now())
ON CONFLICT (key) DO NOTHING;
