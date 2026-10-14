-- R3-T03 PR-B：新表统一租户隔离（硬规则 7）。
SELECT enable_tenant_isolation('survey360_todos');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_todos TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_report_templates');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_report_templates TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_reports');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_reports TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_report_links');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_report_links TO app_user;
