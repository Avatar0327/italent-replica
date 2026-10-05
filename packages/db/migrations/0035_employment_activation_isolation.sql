-- R1-T08：定时生效尝试强制租户隔离、只追加（DEC-052 失败次数与原因、DEC-112 挂起记录不得改写）。
SELECT enable_tenant_isolation('employment_activation_attempts');
--> statement-breakpoint
GRANT SELECT, INSERT ON employment_activation_attempts TO app_user;
--> statement-breakpoint
CREATE TRIGGER employment_activation_attempts_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON employment_activation_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
