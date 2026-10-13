-- B4：风险结果按租户隔离，授权对象及管理员预置已由契约登记。
SELECT enable_tenant_isolation('succession_risk_results');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON succession_risk_results TO app_user;
