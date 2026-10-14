-- 设计 §1.3 / §1.4：重排可交换排序号，唯一性在事务提交时检查；人员范围引用仍为即时 RESTRICT。
ALTER TABLE succession_risk_levels ADD CONSTRAINT succession_risk_levels_order
  UNIQUE (tenant_id, display_order) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE succession_health_levels ADD CONSTRAINT succession_health_levels_order
  UNIQUE (tenant_id, display_order) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
SELECT enable_tenant_isolation('succession_risk_levels');
--> statement-breakpoint
SELECT enable_tenant_isolation('succession_risk_level_rows');
--> statement-breakpoint
SELECT enable_tenant_isolation('succession_health_levels');
--> statement-breakpoint
SELECT enable_tenant_isolation('succession_health_level_rows');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON succession_risk_levels, succession_risk_level_rows,
  succession_health_levels, succession_health_level_rows TO app_user;
