-- 组织主数据租户隔离（R1-T03；AGENTS.md §2/§10、docs/02_业务建模/10 §8.3）。
-- 所有组织表都带 tenant_id，复用底座统一策略，并强制表属主同样受 RLS 约束。
SELECT enable_tenant_isolation('org_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('org_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('org_hierarchy_links');
--> statement-breakpoint
SELECT enable_tenant_isolation('org_settings');
--> statement-breakpoint
SELECT enable_tenant_isolation('org_code_reservations');
--> statement-breakpoint
SELECT enable_tenant_isolation('org_import_mappings');
--> statement-breakpoint
SELECT enable_tenant_isolation('org_import_results');
--> statement-breakpoint
-- 稳定对象只改编码与 revision；设置和预占通过同租户设置行锁协调，保留释放历史。
GRANT SELECT, INSERT, UPDATE ON org_objects, org_settings, org_code_reservations TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON org_versions, org_hierarchy_links, org_import_mappings, org_import_results TO app_user;
--> statement-breakpoint
-- 业务版本、各维层级及导入回执只允许追加，连接角色也不得覆盖历史。
CREATE TRIGGER org_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON org_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER org_hierarchy_links_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON org_hierarchy_links
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER org_import_results_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON org_import_results
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
