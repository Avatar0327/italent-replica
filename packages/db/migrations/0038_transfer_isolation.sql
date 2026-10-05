-- R1-T09：每张配置和请求表强制租户隔离；历史表单/设置版本及业务入口绑定不可改写。
SELECT enable_tenant_isolation('transfer_types');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON transfer_types TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('transfer_reasons');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON transfer_reasons TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('transfer_settings');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON transfer_settings TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('transfer_setting_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON transfer_setting_versions TO app_user;
--> statement-breakpoint
CREATE TRIGGER transfer_setting_versions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON transfer_setting_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('transfer_forms');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON transfer_forms TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('transfer_form_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON transfer_form_versions TO app_user;
--> statement-breakpoint
CREATE TRIGGER transfer_form_versions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON transfer_form_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('transfer_form_fields');
--> statement-breakpoint
GRANT SELECT, INSERT ON transfer_form_fields TO app_user;
--> statement-breakpoint
CREATE TRIGGER transfer_form_fields_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON transfer_form_fields FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('transfer_requests');
--> statement-breakpoint
GRANT SELECT, INSERT ON transfer_requests TO app_user;
--> statement-breakpoint
CREATE TRIGGER transfer_requests_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON transfer_requests FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
