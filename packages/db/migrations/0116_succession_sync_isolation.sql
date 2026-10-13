-- D1：四表统一租户隔离，A1 / B3 预留的批次引用在此补齐。
SELECT enable_tenant_isolation('succession_sync_batches');
--> statement-breakpoint
SELECT enable_tenant_isolation('succession_sync_items');
--> statement-breakpoint
SELECT enable_tenant_isolation('succession_sync_targets');
--> statement-breakpoint
SELECT enable_tenant_isolation('succession_sync_mutex');
--> statement-breakpoint
ALTER TABLE succession_records ADD CONSTRAINT succession_records_source_batch_fk
  FOREIGN KEY (tenant_id, source_batch_id) REFERENCES succession_sync_batches(tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE succession_notifications ADD CONSTRAINT succession_notifications_batch_fk
  FOREIGN KEY (tenant_id, batch_id) REFERENCES succession_sync_batches(tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON succession_sync_batches, succession_sync_items,
  succession_sync_targets, succession_sync_mutex TO app_user;
