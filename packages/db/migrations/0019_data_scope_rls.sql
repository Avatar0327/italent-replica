-- R1-T02：所有范围正表强制租户隔离；版本只追加。
SELECT enable_tenant_isolation('permission_mous');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_mou_org_refs');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_user_app_scopes');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_scope_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_identity_scopes');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_user_person_links');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_dynamic_org_grants');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_scope_policies');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_scope_policy_rules');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_scope_apps');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON permission_mous, permission_user_app_scopes,
  permission_identity_scopes, permission_user_person_links, permission_dynamic_org_grants,
  permission_scope_policies, permission_scope_apps TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON permission_mou_org_refs, permission_scope_policy_rules TO app_user;
--> statement-breakpoint
GRANT DELETE ON permission_user_person_links, permission_dynamic_org_grants TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON permission_scope_versions TO app_user;
--> statement-breakpoint
CREATE TRIGGER permission_scope_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON permission_scope_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE FUNCTION validate_dynamic_org_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permission_grants
    WHERE tenant_id=NEW.tenant_id AND id=NEW.grant_id AND source='auto') THEN
    RAISE EXCEPTION '组织角色范围只能关联自动授权' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER permission_dynamic_grants_auto_only
  BEFORE INSERT OR UPDATE ON permission_dynamic_org_grants
  FOR EACH ROW EXECUTE FUNCTION validate_dynamic_org_grant();
--> statement-breakpoint
CREATE INDEX audit_events_scope_creator_lookup
  ON audit_events (tenant_id, object_id, action, occurred_at);
