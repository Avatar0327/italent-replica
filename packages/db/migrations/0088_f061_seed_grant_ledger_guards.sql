-- F-061 PR-1：种子授权补装台账 seed_grant_ledger 的租户隔离、最小权限与只追加（方案 §3.3）。
-- 租户 RLS 同其他租户表；应用角色只能新增与读取；表属主也不能改删（语句级触发器，沿用 0006 的 forbid_audit_mutation）。
-- 台账不参与鉴权，只记录“平台装过 / 已存在 / 租户动过 / 保守不补”，回补据此不把租户撤销过的授权补回。
SELECT enable_tenant_isolation('seed_grant_ledger');
--> statement-breakpoint
GRANT SELECT, INSERT ON seed_grant_ledger TO app_user;
--> statement-breakpoint
CREATE TRIGGER seed_grant_ledger_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON seed_grant_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
