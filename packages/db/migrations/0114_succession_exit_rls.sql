-- A3 / 设计 §5.4：租户隔离；只通过同事务钩子和 worker 更新台账。
SELECT enable_tenant_isolation('succession_exit_applications');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON succession_exit_applications TO app_user;
