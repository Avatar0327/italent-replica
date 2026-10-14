-- C1：个人显示设置与组织统计各自按租户隔离；不新增授权编码（Map 契约已登记）。
SELECT enable_tenant_isolation('succession_map_preferences');
--> statement-breakpoint
SELECT enable_tenant_isolation('succession_org_stats');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON succession_map_preferences, succession_org_stats TO app_user;
