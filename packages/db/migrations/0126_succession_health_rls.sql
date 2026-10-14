SELECT enable_tenant_isolation('succession_health_results');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON succession_health_results TO app_user;
