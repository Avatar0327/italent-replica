SELECT enable_tenant_isolation('succession_populations');
--> statement-breakpoint
SELECT enable_tenant_isolation('succession_population_rows');
--> statement-breakpoint
SELECT enable_tenant_isolation('succession_rule_settings');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON succession_populations, succession_population_rows,
  succession_rule_settings TO app_user;
