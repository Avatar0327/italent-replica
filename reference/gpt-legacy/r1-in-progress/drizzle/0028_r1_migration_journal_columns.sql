-- Full-row recovery journal for R1 expansion. Cursor caches and assertion tables are reconstructed/invalidated, never restored as authority.
DROP TRIGGER IF EXISTS r1_log_r1_migration_runs_insert;
CREATE TRIGGER r1_log_r1_migration_runs_insert AFTER INSERT ON "r1_migration_runs"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_runs',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'plan_version',NEW."plan_version",'source_sha',NEW."source_sha",'ddl_digest',NEW."ddl_digest",'phase',NEW."phase",'revision',NEW."revision",'writer_epoch',NEW."writer_epoch",'lease_owner',NEW."lease_owner",'lease_until',NEW."lease_until",'fencing_token',NEW."fencing_token",'source_table',NEW."source_table",'cursor',NEW."cursor",'rows_observed',NEW."rows_observed",'manifest_digest',NEW."manifest_digest",'reason_code',NEW."reason_code",'created_at',NEW."created_at",'scan_generation',NEW."scan_generation"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
DROP TRIGGER IF EXISTS r1_log_r1_migration_runs_update;
CREATE TRIGGER r1_log_r1_migration_runs_update AFTER UPDATE ON "r1_migration_runs"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_runs',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'plan_version',NEW."plan_version",'source_sha',NEW."source_sha",'ddl_digest',NEW."ddl_digest",'phase',NEW."phase",'revision',NEW."revision",'writer_epoch',NEW."writer_epoch",'lease_owner',NEW."lease_owner",'lease_until',NEW."lease_until",'fencing_token',NEW."fencing_token",'source_table',NEW."source_table",'cursor',NEW."cursor",'rows_observed',NEW."rows_observed",'manifest_digest',NEW."manifest_digest",'reason_code',NEW."reason_code",'created_at',NEW."created_at",'scan_generation',NEW."scan_generation"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
DROP TRIGGER IF EXISTS r1_log_r1_migration_runs_delete;
CREATE TRIGGER r1_log_r1_migration_runs_delete AFTER DELETE ON "r1_migration_runs"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_runs',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
DROP TRIGGER IF EXISTS r1_log_r1_schema_state_insert;
CREATE TRIGGER r1_log_r1_schema_state_insert AFTER INSERT ON "r1_schema_state"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_schema_state',json_array(NEW."tenant_id"),'insert',json_object('tenant_id',NEW."tenant_id",'schema_version',NEW."schema_version",'writer_epoch',NEW."writer_epoch",'recovery_epoch',NEW."recovery_epoch",'authorization_revision',NEW."authorization_revision",'phase',NEW."phase",'open_gate',NEW."open_gate",'features_enabled',NEW."features_enabled",'report_scope_revision',NEW."report_scope_revision",'migration_source_revision',NEW."migration_source_revision"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
DROP TRIGGER IF EXISTS r1_log_r1_schema_state_update;
CREATE TRIGGER r1_log_r1_schema_state_update AFTER UPDATE ON "r1_schema_state"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_schema_state',json_array(NEW."tenant_id"),'update',json_object('tenant_id',NEW."tenant_id",'schema_version',NEW."schema_version",'writer_epoch',NEW."writer_epoch",'recovery_epoch',NEW."recovery_epoch",'authorization_revision',NEW."authorization_revision",'phase',NEW."phase",'open_gate',NEW."open_gate",'features_enabled',NEW."features_enabled",'report_scope_revision',NEW."report_scope_revision",'migration_source_revision',NEW."migration_source_revision"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
DROP TRIGGER IF EXISTS r1_log_r1_schema_state_delete;
CREATE TRIGGER r1_log_r1_schema_state_delete AFTER DELETE ON "r1_schema_state"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_schema_state',json_array(OLD."tenant_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
