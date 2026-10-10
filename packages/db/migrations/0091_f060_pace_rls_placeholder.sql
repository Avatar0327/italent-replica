-- F-060 收尾（DEC-392）：答卷计时表的租户隔离（硬规则 7；guard-rls）。只记 / 改计时点，应用角色不授 DELETE。
SELECT enable_tenant_isolation('survey360_sheet_timings');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON survey360_sheet_timings TO app_user;
