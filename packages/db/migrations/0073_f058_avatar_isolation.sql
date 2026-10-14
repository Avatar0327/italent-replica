-- F-058：头像对象、文件及领域事件都隔离到当前租户，不存在公共附件地址。
SELECT enable_tenant_isolation('account_avatar_settings');
--> statement-breakpoint
SELECT enable_tenant_isolation('account_avatar_attachments');
--> statement-breakpoint
SELECT enable_tenant_isolation('account_avatar_outbox');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON account_avatar_settings, account_avatar_attachments,
  account_avatar_outbox TO app_user;
