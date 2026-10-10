-- F-060 收尾（DEC-392）：答卷计时表的租户隔离（硬规则 7；guard-rls）。记 / 改计时点；重新作答与移除评价对象清掉答卷时一并删除（DELETE）。
SELECT enable_tenant_isolation('survey360_sheet_timings');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_sheet_timings TO app_user;
