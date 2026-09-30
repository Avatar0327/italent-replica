-- Full-row recovery journal for R1 expansion. Cursor caches and assertion tables are reconstructed/invalidated, never restored as authority.
CREATE TRIGGER r1_log_r1_admin_delegations_insert AFTER INSERT ON "r1_admin_delegations"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_admin_delegations',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'principal_id',NEW."principal_id",'delegate_id',NEW."delegate_id",'actions',NEW."actions",'business_types',NEW."business_types",'scope',NEW."scope",'fields',NEW."fields",'start_at',NEW."start_at",'end_at',NEW."end_at",'accepted_at',NEW."accepted_at",'revision',NEW."revision",'status',NEW."status",'revoke_reason',NEW."revoke_reason"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_admin_delegations_update AFTER UPDATE ON "r1_admin_delegations"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_admin_delegations',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'principal_id',NEW."principal_id",'delegate_id',NEW."delegate_id",'actions',NEW."actions",'business_types',NEW."business_types",'scope',NEW."scope",'fields',NEW."fields",'start_at',NEW."start_at",'end_at',NEW."end_at",'accepted_at',NEW."accepted_at",'revision',NEW."revision",'status',NEW."status",'revoke_reason',NEW."revoke_reason"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_admin_delegations_delete AFTER DELETE ON "r1_admin_delegations"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_admin_delegations',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_attachment_integrity_insert AFTER INSERT ON "r1_attachment_integrity"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_attachment_integrity',json_array(NEW."tenant_id",NEW."attachment_id"),'insert',json_object('tenant_id',NEW."tenant_id",'attachment_id',NEW."attachment_id",'object_key',NEW."object_key",'digest',NEW."digest",'byte_count',NEW."byte_count",'status',NEW."status",'reason_code',NEW."reason_code",'observed_at',NEW."observed_at",'source_digest',NEW."source_digest"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_attachment_integrity_update AFTER UPDATE ON "r1_attachment_integrity"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_attachment_integrity',json_array(NEW."tenant_id",NEW."attachment_id"),'update',json_object('tenant_id',NEW."tenant_id",'attachment_id',NEW."attachment_id",'object_key',NEW."object_key",'digest',NEW."digest",'byte_count',NEW."byte_count",'status',NEW."status",'reason_code',NEW."reason_code",'observed_at',NEW."observed_at",'source_digest',NEW."source_digest"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_attachment_integrity_delete AFTER DELETE ON "r1_attachment_integrity"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_attachment_integrity',json_array(OLD."tenant_id",OLD."attachment_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_callback_nonces_insert AFTER INSERT ON "r1_callback_nonces"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_callback_nonces',json_array(NEW."tenant_id",NEW."source",NEW."nonce"),'insert',json_object('tenant_id',NEW."tenant_id",'source',NEW."source",'nonce',NEW."nonce",'digest',NEW."digest",'received_at',NEW."received_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_callback_nonces_update AFTER UPDATE ON "r1_callback_nonces"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_callback_nonces',json_array(NEW."tenant_id",NEW."source",NEW."nonce"),'update',json_object('tenant_id',NEW."tenant_id",'source',NEW."source",'nonce',NEW."nonce",'digest',NEW."digest",'received_at',NEW."received_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_callback_nonces_delete AFTER DELETE ON "r1_callback_nonces"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_callback_nonces',json_array(OLD."tenant_id",OLD."source",OLD."nonce"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_commands_insert AFTER INSERT ON "r1_commands"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,NEW.token,'r1_commands',json_array(NEW."tenant_id",NEW."command_id"),'insert',json_object('tenant_id',NEW."tenant_id",'command_id',NEW."command_id",'actor_id',NEW."actor_id",'action',NEW."action",'idempotency_key',NEW."idempotency_key",'request_digest',NEW."request_digest",'token',NEW."token",'status',NEW."status",'workspace_revision',NEW."workspace_revision",'authorization_revision',NEW."authorization_revision",'writer_epoch',NEW."writer_epoch",'recovery_epoch',NEW."recovery_epoch",'result',NEW."result",'created_at',NEW."created_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),NEW.workspace_revision+1);
END;
CREATE TRIGGER r1_log_r1_commands_update AFTER UPDATE ON "r1_commands"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,CASE WHEN NEW.token=(SELECT last_mutation FROM hris_workspaces WHERE owner=NEW.tenant_id) THEN NEW.token ELSE coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))) END,'r1_commands',json_array(NEW."tenant_id",NEW."command_id"),'update',json_object('tenant_id',NEW."tenant_id",'command_id',NEW."command_id",'actor_id',NEW."actor_id",'action',NEW."action",'idempotency_key',NEW."idempotency_key",'request_digest',NEW."request_digest",'token',NEW."token",'status',NEW."status",'workspace_revision',NEW."workspace_revision",'authorization_revision',NEW."authorization_revision",'writer_epoch',NEW."writer_epoch",'recovery_epoch',NEW."recovery_epoch",'result',NEW."result",'created_at',NEW."created_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_commands_delete AFTER DELETE ON "r1_commands"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_commands',json_array(OLD."tenant_id",OLD."command_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_consumer_cursors_insert AFTER INSERT ON "r1_consumer_cursors"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_consumer_cursors',json_array(NEW."tenant_id",NEW."consumer_id",NEW."source",NEW."entity_id"),'insert',json_object('tenant_id',NEW."tenant_id",'consumer_id',NEW."consumer_id",'source',NEW."source",'entity_id',NEW."entity_id",'sequence',NEW."sequence"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_consumer_cursors_update AFTER UPDATE ON "r1_consumer_cursors"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_consumer_cursors',json_array(NEW."tenant_id",NEW."consumer_id",NEW."source",NEW."entity_id"),'update',json_object('tenant_id',NEW."tenant_id",'consumer_id',NEW."consumer_id",'source',NEW."source",'entity_id',NEW."entity_id",'sequence',NEW."sequence"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_consumer_cursors_delete AFTER DELETE ON "r1_consumer_cursors"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_consumer_cursors',json_array(OLD."tenant_id",OLD."consumer_id",OLD."source",OLD."entity_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_consumer_inbox_insert AFTER INSERT ON "r1_consumer_inbox"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_consumer_inbox',json_array(NEW."tenant_id",NEW."consumer_id",NEW."source",NEW."event_id"),'insert',json_object('tenant_id',NEW."tenant_id",'consumer_id',NEW."consumer_id",'source',NEW."source",'event_id',NEW."event_id",'sequence',NEW."sequence",'entity_id',NEW."entity_id",'digest',NEW."digest",'mapping_version',NEW."mapping_version",'received_at',NEW."received_at",'status',NEW."status"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_consumer_inbox_update AFTER UPDATE ON "r1_consumer_inbox"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_consumer_inbox',json_array(NEW."tenant_id",NEW."consumer_id",NEW."source",NEW."event_id"),'update',json_object('tenant_id',NEW."tenant_id",'consumer_id',NEW."consumer_id",'source',NEW."source",'event_id',NEW."event_id",'sequence',NEW."sequence",'entity_id',NEW."entity_id",'digest',NEW."digest",'mapping_version',NEW."mapping_version",'received_at',NEW."received_at",'status',NEW."status"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_consumer_inbox_delete AFTER DELETE ON "r1_consumer_inbox"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_consumer_inbox',json_array(OLD."tenant_id",OLD."consumer_id",OLD."source",OLD."event_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_deliveries_insert AFTER INSERT ON "r1_deliveries"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_deliveries',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'source_id',NEW."source_id",'source_revision',NEW."source_revision",'recipient_id',NEW."recipient_id",'state',NEW."state",'receipt_id',NEW."receipt_id",'receipt_digest',NEW."receipt_digest",'external_mode',NEW."external_mode",'source_namespace',NEW."source_namespace",'payload',NEW."payload",'payload_digest',NEW."payload_digest",'attempt',NEW."attempt",'next_attempt_at',NEW."next_attempt_at",'owner_id',NEW."owner_id",'reason_code',NEW."reason_code",'org_id',NEW."org_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_deliveries_update AFTER UPDATE ON "r1_deliveries"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_deliveries',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'source_id',NEW."source_id",'source_revision',NEW."source_revision",'recipient_id',NEW."recipient_id",'state',NEW."state",'receipt_id',NEW."receipt_id",'receipt_digest',NEW."receipt_digest",'external_mode',NEW."external_mode",'source_namespace',NEW."source_namespace",'payload',NEW."payload",'payload_digest',NEW."payload_digest",'attempt',NEW."attempt",'next_attempt_at',NEW."next_attempt_at",'owner_id',NEW."owner_id",'reason_code',NEW."reason_code",'org_id',NEW."org_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_deliveries_delete AFTER DELETE ON "r1_deliveries"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_deliveries',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_exit_cleanup_insert AFTER INSERT ON "r1_exit_cleanup"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_exit_cleanup',json_array(NEW."tenant_id",NEW."person_id",NEW."business_type",NEW."business_id"),'insert',json_object('tenant_id',NEW."tenant_id",'person_id',NEW."person_id",'business_type',NEW."business_type",'business_id',NEW."business_id",'status',NEW."status",'reason',NEW."reason"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_exit_cleanup_update AFTER UPDATE ON "r1_exit_cleanup"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_exit_cleanup',json_array(NEW."tenant_id",NEW."person_id",NEW."business_type",NEW."business_id"),'update',json_object('tenant_id',NEW."tenant_id",'person_id',NEW."person_id",'business_type',NEW."business_type",'business_id',NEW."business_id",'status',NEW."status",'reason',NEW."reason"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_exit_cleanup_delete AFTER DELETE ON "r1_exit_cleanup"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_exit_cleanup',json_array(OLD."tenant_id",OLD."person_id",OLD."business_type",OLD."business_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_exit_fences_insert AFTER INSERT ON "r1_exit_fences"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_exit_fences',json_array(NEW."tenant_id",NEW."person_id"),'insert',json_object('tenant_id',NEW."tenant_id",'person_id',NEW."person_id",'effective_at',NEW."effective_at",'command_id',NEW."command_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_exit_fences_update AFTER UPDATE ON "r1_exit_fences"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_exit_fences',json_array(NEW."tenant_id",NEW."person_id"),'update',json_object('tenant_id',NEW."tenant_id",'person_id',NEW."person_id",'effective_at',NEW."effective_at",'command_id',NEW."command_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_exit_fences_delete AFTER DELETE ON "r1_exit_fences"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_exit_fences',json_array(OLD."tenant_id",OLD."person_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_external_receipts_insert AFTER INSERT ON "r1_external_receipts"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_external_receipts',json_array(NEW."tenant_id",NEW."source",NEW."receipt_id"),'insert',json_object('tenant_id',NEW."tenant_id",'source',NEW."source",'receipt_id',NEW."receipt_id",'delivery_id',NEW."delivery_id",'digest',NEW."digest",'state',NEW."state",'key_id',NEW."key_id",'received_at',NEW."received_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_external_receipts_update AFTER UPDATE ON "r1_external_receipts"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_external_receipts',json_array(NEW."tenant_id",NEW."source",NEW."receipt_id"),'update',json_object('tenant_id',NEW."tenant_id",'source',NEW."source",'receipt_id',NEW."receipt_id",'delivery_id',NEW."delivery_id",'digest',NEW."digest",'state',NEW."state",'key_id',NEW."key_id",'received_at',NEW."received_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_external_receipts_delete AFTER DELETE ON "r1_external_receipts"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_external_receipts',json_array(OLD."tenant_id",OLD."source",OLD."receipt_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_identity_keys_insert AFTER INSERT ON "r1_identity_keys"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_identity_keys',json_array(NEW."tenant_id",NEW."person_id",NEW."identifier_type",NEW."value_digest"),'insert',json_object('tenant_id',NEW."tenant_id",'person_id',NEW."person_id",'identifier_type',NEW."identifier_type",'value_digest',NEW."value_digest",'verified_by',NEW."verified_by",'verified_at',NEW."verified_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_identity_keys_update AFTER UPDATE ON "r1_identity_keys"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_identity_keys',json_array(NEW."tenant_id",NEW."person_id",NEW."identifier_type",NEW."value_digest"),'update',json_object('tenant_id',NEW."tenant_id",'person_id',NEW."person_id",'identifier_type',NEW."identifier_type",'value_digest',NEW."value_digest",'verified_by',NEW."verified_by",'verified_at',NEW."verified_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_identity_keys_delete AFTER DELETE ON "r1_identity_keys"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_identity_keys',json_array(OLD."tenant_id",OLD."person_id",OLD."identifier_type",OLD."value_digest"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_import_receipts_insert AFTER INSERT ON "r1_import_receipts"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_import_receipts',json_array(NEW."tenant_id",NEW."batch_id",NEW."row_no",NEW."attempt_version"),'insert',json_object('tenant_id',NEW."tenant_id",'batch_id',NEW."batch_id",'row_no',NEW."row_no",'attempt_version',NEW."attempt_version",'request_digest',NEW."request_digest",'entity_id',NEW."entity_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_import_receipts_update AFTER UPDATE ON "r1_import_receipts"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_import_receipts',json_array(NEW."tenant_id",NEW."batch_id",NEW."row_no",NEW."attempt_version"),'update',json_object('tenant_id',NEW."tenant_id",'batch_id',NEW."batch_id",'row_no',NEW."row_no",'attempt_version',NEW."attempt_version",'request_digest',NEW."request_digest",'entity_id',NEW."entity_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_import_receipts_delete AFTER DELETE ON "r1_import_receipts"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_import_receipts',json_array(OLD."tenant_id",OLD."batch_id",OLD."row_no",OLD."attempt_version"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_inbox_insert AFTER INSERT ON "r1_inbox"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_inbox',json_array(NEW."tenant_id",NEW."source",NEW."event_id"),'insert',json_object('tenant_id',NEW."tenant_id",'source',NEW."source",'event_id',NEW."event_id",'sequence',NEW."sequence",'entity_id',NEW."entity_id",'digest',NEW."digest",'mapping_version',NEW."mapping_version",'received_at',NEW."received_at",'status',NEW."status"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_inbox_update AFTER UPDATE ON "r1_inbox"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_inbox',json_array(NEW."tenant_id",NEW."source",NEW."event_id"),'update',json_object('tenant_id',NEW."tenant_id",'source',NEW."source",'event_id',NEW."event_id",'sequence',NEW."sequence",'entity_id',NEW."entity_id",'digest',NEW."digest",'mapping_version',NEW."mapping_version",'received_at',NEW."received_at",'status',NEW."status"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_inbox_delete AFTER DELETE ON "r1_inbox"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_inbox',json_array(OLD."tenant_id",OLD."source",OLD."event_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_integration_quarantine_insert AFTER INSERT ON "r1_integration_quarantine"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_integration_quarantine',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'source',NEW."source",'event_id',NEW."event_id",'reason',NEW."reason",'digest',NEW."digest",'owner_id',NEW."owner_id",'next_action',NEW."next_action",'close_gate',NEW."close_gate"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_integration_quarantine_update AFTER UPDATE ON "r1_integration_quarantine"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_integration_quarantine',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'source',NEW."source",'event_id',NEW."event_id",'reason',NEW."reason",'digest',NEW."digest",'owner_id',NEW."owner_id",'next_action',NEW."next_action",'close_gate',NEW."close_gate"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_integration_quarantine_delete AFTER DELETE ON "r1_integration_quarantine"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_integration_quarantine',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_m01_entities_insert AFTER INSERT ON "r1_m01_entities"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_m01_entities',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'kind',NEW."kind",'person_id',NEW."person_id",'org_id',NEW."org_id",'code',NEW."code",'revision',NEW."revision",'status',NEW."status",'payload',NEW."payload"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_m01_entities_update AFTER UPDATE ON "r1_m01_entities"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_m01_entities',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'kind',NEW."kind",'person_id',NEW."person_id",'org_id',NEW."org_id",'code',NEW."code",'revision',NEW."revision",'status',NEW."status",'payload',NEW."payload"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_m01_entities_delete AFTER DELETE ON "r1_m01_entities"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_m01_entities',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_m01_versions_insert AFTER INSERT ON "r1_m01_versions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_m01_versions',json_array(NEW."tenant_id",NEW."entity_id",NEW."version"),'insert',json_object('tenant_id',NEW."tenant_id",'entity_id',NEW."entity_id",'version',NEW."version",'workspace_revision',NEW."workspace_revision",'command_id',NEW."command_id",'recorded_at',NEW."recorded_at",'valid_from',NEW."valid_from",'valid_to',NEW."valid_to",'history_quality',NEW."history_quality",'payload',NEW."payload"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_m01_versions_update AFTER UPDATE ON "r1_m01_versions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_m01_versions',json_array(NEW."tenant_id",NEW."entity_id",NEW."version"),'update',json_object('tenant_id',NEW."tenant_id",'entity_id',NEW."entity_id",'version',NEW."version",'workspace_revision',NEW."workspace_revision",'command_id',NEW."command_id",'recorded_at',NEW."recorded_at",'valid_from',NEW."valid_from",'valid_to',NEW."valid_to",'history_quality',NEW."history_quality",'payload',NEW."payload"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_m01_versions_delete AFTER DELETE ON "r1_m01_versions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_m01_versions',json_array(OLD."tenant_id",OLD."entity_id",OLD."version"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_member_roles_insert AFTER INSERT ON "r1_member_roles"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_member_roles',json_array(NEW."tenant_id",NEW."member_id",NEW."role_id"),'insert',json_object('tenant_id',NEW."tenant_id",'member_id',NEW."member_id",'role_id',NEW."role_id",'valid_from',NEW."valid_from",'valid_to',NEW."valid_to",'active',NEW."active"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_member_roles_update AFTER UPDATE ON "r1_member_roles"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_member_roles',json_array(NEW."tenant_id",NEW."member_id",NEW."role_id"),'update',json_object('tenant_id',NEW."tenant_id",'member_id',NEW."member_id",'role_id',NEW."role_id",'valid_from',NEW."valid_from",'valid_to',NEW."valid_to",'active',NEW."active"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_member_roles_delete AFTER DELETE ON "r1_member_roles"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_member_roles',json_array(OLD."tenant_id",OLD."member_id",OLD."role_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_archives_insert AFTER INSERT ON "r1_migration_archives"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_archives',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'source_revision',NEW."source_revision",'source_digest',NEW."source_digest",'source_json',NEW."source_json",'created_at',NEW."created_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_archives_update AFTER UPDATE ON "r1_migration_archives"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_archives',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'source_revision',NEW."source_revision",'source_digest',NEW."source_digest",'source_json',NEW."source_json",'created_at',NEW."created_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_archives_delete AFTER DELETE ON "r1_migration_archives"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_archives',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_batches_insert AFTER INSERT ON "r1_migration_batches"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_batches',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'run_id',NEW."run_id",'source_table',NEW."source_table",'cursor_digest',NEW."cursor_digest",'from_key',NEW."from_key",'to_key',NEW."to_key",'row_count',NEW."row_count",'input_digest',NEW."input_digest",'output_digest',NEW."output_digest",'fencing_token',NEW."fencing_token",'command_id',NEW."command_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_batches_update AFTER UPDATE ON "r1_migration_batches"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_batches',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'run_id',NEW."run_id",'source_table',NEW."source_table",'cursor_digest',NEW."cursor_digest",'from_key',NEW."from_key",'to_key',NEW."to_key",'row_count',NEW."row_count",'input_digest',NEW."input_digest",'output_digest',NEW."output_digest",'fencing_token',NEW."fencing_token",'command_id',NEW."command_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_batches_delete AFTER DELETE ON "r1_migration_batches"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_batches',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_issues_insert AFTER INSERT ON "r1_migration_issues"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_issues',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'source_table',NEW."source_table",'source_key',NEW."source_key",'target_id',NEW."target_id",'reason_code',NEW."reason_code",'status',NEW."status",'revision',NEW."revision",'evidence_ref',NEW."evidence_ref",'resolved_by',NEW."resolved_by",'detail',NEW."detail"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_issues_update AFTER UPDATE ON "r1_migration_issues"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_issues',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'source_table',NEW."source_table",'source_key',NEW."source_key",'target_id',NEW."target_id",'reason_code',NEW."reason_code",'status',NEW."status",'revision',NEW."revision",'evidence_ref',NEW."evidence_ref",'resolved_by',NEW."resolved_by",'detail',NEW."detail"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_issues_delete AFTER DELETE ON "r1_migration_issues"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_issues',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_map_insert AFTER INSERT ON "r1_migration_map"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_map',json_array(NEW."tenant_id",NEW."source_table",NEW."source_key",NEW."mapping_version",NEW."ordinal"),'insert',json_object('tenant_id',NEW."tenant_id",'source_table',NEW."source_table",'source_key',NEW."source_key",'mapping_version',NEW."mapping_version",'ordinal',NEW."ordinal",'source_revision',NEW."source_revision",'source_digest',NEW."source_digest",'target_kind',NEW."target_kind",'target_id',NEW."target_id",'confidence',NEW."confidence",'issue_id',NEW."issue_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_map_update AFTER UPDATE ON "r1_migration_map"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_map',json_array(NEW."tenant_id",NEW."source_table",NEW."source_key",NEW."mapping_version",NEW."ordinal"),'update',json_object('tenant_id',NEW."tenant_id",'source_table',NEW."source_table",'source_key',NEW."source_key",'mapping_version',NEW."mapping_version",'ordinal',NEW."ordinal",'source_revision',NEW."source_revision",'source_digest',NEW."source_digest",'target_kind',NEW."target_kind",'target_id',NEW."target_id",'confidence',NEW."confidence",'issue_id',NEW."issue_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_map_delete AFTER DELETE ON "r1_migration_map"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_map',json_array(OLD."tenant_id",OLD."source_table",OLD."source_key",OLD."mapping_version",OLD."ordinal"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_observations_insert AFTER INSERT ON "r1_migration_observations"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_observations',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'run_id',NEW."run_id",'source_table',NEW."source_table",'source_key',NEW."source_key",'source_revision',NEW."source_revision",'source_digest',NEW."source_digest",'source_image',NEW."source_image",'recorded_at',NEW."recorded_at",'history_quality',NEW."history_quality"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_observations_update AFTER UPDATE ON "r1_migration_observations"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_observations',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'run_id',NEW."run_id",'source_table',NEW."source_table",'source_key',NEW."source_key",'source_revision',NEW."source_revision",'source_digest',NEW."source_digest",'source_image',NEW."source_image",'recorded_at',NEW."recorded_at",'history_quality',NEW."history_quality"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_observations_delete AFTER DELETE ON "r1_migration_observations"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_observations',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_reconciliation_insert AFTER INSERT ON "r1_migration_reconciliation"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_reconciliation',json_array(NEW."tenant_id",NEW."run_id",NEW."source_table"),'insert',json_object('tenant_id',NEW."tenant_id",'run_id',NEW."run_id",'source_table',NEW."source_table",'cursor',NEW."cursor",'row_count',NEW."row_count",'digest',NEW."digest",'difference_count',NEW."difference_count",'source_revision',NEW."source_revision",'completed',NEW."completed"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_reconciliation_update AFTER UPDATE ON "r1_migration_reconciliation"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_reconciliation',json_array(NEW."tenant_id",NEW."run_id",NEW."source_table"),'update',json_object('tenant_id',NEW."tenant_id",'run_id',NEW."run_id",'source_table',NEW."source_table",'cursor',NEW."cursor",'row_count',NEW."row_count",'digest',NEW."digest",'difference_count',NEW."difference_count",'source_revision',NEW."source_revision",'completed',NEW."completed"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_reconciliation_delete AFTER DELETE ON "r1_migration_reconciliation"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_reconciliation',json_array(OLD."tenant_id",OLD."run_id",OLD."source_table"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_runs_insert AFTER INSERT ON "r1_migration_runs"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_runs',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'plan_version',NEW."plan_version",'source_sha',NEW."source_sha",'ddl_digest',NEW."ddl_digest",'phase',NEW."phase",'revision',NEW."revision",'writer_epoch',NEW."writer_epoch",'lease_owner',NEW."lease_owner",'lease_until',NEW."lease_until",'fencing_token',NEW."fencing_token",'source_table',NEW."source_table",'cursor',NEW."cursor",'rows_observed',NEW."rows_observed",'manifest_digest',NEW."manifest_digest",'reason_code',NEW."reason_code",'created_at',NEW."created_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_runs_update AFTER UPDATE ON "r1_migration_runs"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_runs',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'plan_version',NEW."plan_version",'source_sha',NEW."source_sha",'ddl_digest',NEW."ddl_digest",'phase',NEW."phase",'revision',NEW."revision",'writer_epoch',NEW."writer_epoch",'lease_owner',NEW."lease_owner",'lease_until',NEW."lease_until",'fencing_token',NEW."fencing_token",'source_table',NEW."source_table",'cursor',NEW."cursor",'rows_observed',NEW."rows_observed",'manifest_digest',NEW."manifest_digest",'reason_code',NEW."reason_code",'created_at',NEW."created_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_migration_runs_delete AFTER DELETE ON "r1_migration_runs"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_migration_runs',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_object_cleanup_insert AFTER INSERT ON "r1_object_cleanup"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_object_cleanup',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'object_key',NEW."object_key",'reason',NEW."reason",'state',NEW."state"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_object_cleanup_update AFTER UPDATE ON "r1_object_cleanup"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_object_cleanup',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'object_key',NEW."object_key",'reason',NEW."reason",'state',NEW."state"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_object_cleanup_delete AFTER DELETE ON "r1_object_cleanup"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_object_cleanup',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_object_upload_intents_insert AFTER INSERT ON "r1_object_upload_intents"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_object_upload_intents',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'actor_id',NEW."actor_id",'org_id',NEW."org_id",'object_key',NEW."object_key",'metadata_digest',NEW."metadata_digest",'created_at',NEW."created_at",'workspace_revision',NEW."workspace_revision",'authorization_revision',NEW."authorization_revision",'state',NEW."state"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_object_upload_intents_update AFTER UPDATE ON "r1_object_upload_intents"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_object_upload_intents',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'actor_id',NEW."actor_id",'org_id',NEW."org_id",'object_key',NEW."object_key",'metadata_digest',NEW."metadata_digest",'created_at',NEW."created_at",'workspace_revision',NEW."workspace_revision",'authorization_revision',NEW."authorization_revision",'state',NEW."state"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_object_upload_intents_delete AFTER DELETE ON "r1_object_upload_intents"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_object_upload_intents',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_occupancy_events_insert AFTER INSERT ON "r1_occupancy_events"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_occupancy_events',json_array(NEW."tenant_id",NEW."event_id"),'insert',json_object('tenant_id',NEW."tenant_id",'event_id',NEW."event_id",'assignment_id',NEW."assignment_id",'person_id',NEW."person_id",'position_id',NEW."position_id",'delta',NEW."delta",'effective_at',NEW."effective_at",'command_id',NEW."command_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_occupancy_events_update AFTER UPDATE ON "r1_occupancy_events"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_occupancy_events',json_array(NEW."tenant_id",NEW."event_id"),'update',json_object('tenant_id',NEW."tenant_id",'event_id',NEW."event_id",'assignment_id',NEW."assignment_id",'person_id',NEW."person_id",'position_id',NEW."position_id",'delta',NEW."delta",'effective_at',NEW."effective_at",'command_id',NEW."command_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_occupancy_events_delete AFTER DELETE ON "r1_occupancy_events"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_occupancy_events',json_array(OLD."tenant_id",OLD."event_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_outbox_insert AFTER INSERT ON "r1_outbox"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_outbox',json_array(NEW."tenant_id",NEW."event_id"),'insert',json_object('tenant_id',NEW."tenant_id",'event_id',NEW."event_id",'command_id',NEW."command_id",'event_type',NEW."event_type",'workspace_revision',NEW."workspace_revision",'payload',NEW."payload",'status',NEW."status"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_outbox_update AFTER UPDATE ON "r1_outbox"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_outbox',json_array(NEW."tenant_id",NEW."event_id"),'update',json_object('tenant_id',NEW."tenant_id",'event_id',NEW."event_id",'command_id',NEW."command_id",'event_type',NEW."event_type",'workspace_revision',NEW."workspace_revision",'payload',NEW."payload",'status',NEW."status"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_outbox_delete AFTER DELETE ON "r1_outbox"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_outbox',json_array(OLD."tenant_id",OLD."event_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_permission_grants_insert AFTER INSERT ON "r1_permission_grants"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_permission_grants',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'member_id',NEW."member_id",'object_type',NEW."object_type",'action',NEW."action",'relation_type',NEW."relation_type",'scope',NEW."scope",'fields',NEW."fields",'history_mode',NEW."history_mode",'valid_from',NEW."valid_from",'valid_to',NEW."valid_to"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_permission_grants_update AFTER UPDATE ON "r1_permission_grants"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_permission_grants',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'member_id',NEW."member_id",'object_type',NEW."object_type",'action',NEW."action",'relation_type',NEW."relation_type",'scope',NEW."scope",'fields',NEW."fields",'history_mode',NEW."history_mode",'valid_from',NEW."valid_from",'valid_to',NEW."valid_to"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_permission_grants_delete AFTER DELETE ON "r1_permission_grants"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_permission_grants',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_portal_invalidations_insert AFTER INSERT ON "r1_portal_invalidations"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_portal_invalidations',json_array(NEW."tenant_id",NEW."source",NEW."source_id"),'insert',json_object('tenant_id',NEW."tenant_id",'source',NEW."source",'source_id',NEW."source_id",'event_id',NEW."event_id",'source_revision',NEW."source_revision",'workspace_revision',NEW."workspace_revision"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_portal_invalidations_update AFTER UPDATE ON "r1_portal_invalidations"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_portal_invalidations',json_array(NEW."tenant_id",NEW."source",NEW."source_id"),'update',json_object('tenant_id',NEW."tenant_id",'source',NEW."source",'source_id',NEW."source_id",'event_id',NEW."event_id",'source_revision',NEW."source_revision",'workspace_revision',NEW."workspace_revision"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_portal_invalidations_delete AFTER DELETE ON "r1_portal_invalidations"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_portal_invalidations',json_array(OLD."tenant_id",OLD."source",OLD."source_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_provider_deliveries_insert AFTER INSERT ON "r1_provider_deliveries"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_provider_deliveries',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'source_id',NEW."source_id",'source_revision',NEW."source_revision",'recipient_id',NEW."recipient_id",'state',NEW."state",'receipt_id',NEW."receipt_id",'receipt_digest',NEW."receipt_digest",'external_mode',NEW."external_mode",'source_namespace',NEW."source_namespace",'payload',NEW."payload",'payload_digest',NEW."payload_digest",'attempt',NEW."attempt",'next_attempt_at',NEW."next_attempt_at",'owner_id',NEW."owner_id",'reason_code',NEW."reason_code",'org_id',NEW."org_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_provider_deliveries_update AFTER UPDATE ON "r1_provider_deliveries"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_provider_deliveries',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'source_id',NEW."source_id",'source_revision',NEW."source_revision",'recipient_id',NEW."recipient_id",'state',NEW."state",'receipt_id',NEW."receipt_id",'receipt_digest',NEW."receipt_digest",'external_mode',NEW."external_mode",'source_namespace',NEW."source_namespace",'payload',NEW."payload",'payload_digest',NEW."payload_digest",'attempt',NEW."attempt",'next_attempt_at',NEW."next_attempt_at",'owner_id',NEW."owner_id",'reason_code',NEW."reason_code",'org_id',NEW."org_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_provider_deliveries_delete AFTER DELETE ON "r1_provider_deliveries"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_provider_deliveries',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_relationships_insert AFTER INSERT ON "r1_relationships"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_relationships',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'manager_person_id',NEW."manager_person_id",'subject_person_id',NEW."subject_person_id",'relation_type',NEW."relation_type",'valid_from',NEW."valid_from",'valid_to',NEW."valid_to",'source_version',NEW."source_version"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_relationships_update AFTER UPDATE ON "r1_relationships"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_relationships',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'manager_person_id',NEW."manager_person_id",'subject_person_id',NEW."subject_person_id",'relation_type',NEW."relation_type",'valid_from',NEW."valid_from",'valid_to',NEW."valid_to",'source_version',NEW."source_version"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_relationships_delete AFTER DELETE ON "r1_relationships"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_relationships',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_chunks_insert AFTER INSERT ON "r1_report_chunks"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_chunks',json_array(NEW."tenant_id",NEW."generation_id",NEW."sequence"),'insert',json_object('tenant_id',NEW."tenant_id",'generation_id',NEW."generation_id",'sequence',NEW."sequence",'first_key',NEW."first_key",'last_key',NEW."last_key",'row_count',NEW."row_count",'byte_count',NEW."byte_count",'digest',NEW."digest"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_chunks_update AFTER UPDATE ON "r1_report_chunks"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_chunks',json_array(NEW."tenant_id",NEW."generation_id",NEW."sequence"),'update',json_object('tenant_id',NEW."tenant_id",'generation_id',NEW."generation_id",'sequence',NEW."sequence",'first_key',NEW."first_key",'last_key',NEW."last_key",'row_count',NEW."row_count",'byte_count',NEW."byte_count",'digest',NEW."digest"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_chunks_delete AFTER DELETE ON "r1_report_chunks"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_chunks',json_array(OLD."tenant_id",OLD."generation_id",OLD."sequence"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_definition_versions_insert AFTER INSERT ON "r1_report_definition_versions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_definition_versions',json_array(NEW."tenant_id",NEW."definition_id",NEW."version"),'insert',json_object('tenant_id',NEW."tenant_id",'definition_id',NEW."definition_id",'version',NEW."version",'digest',NEW."digest",'payload',NEW."payload",'published_by',NEW."published_by",'published_at',NEW."published_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_definition_versions_update AFTER UPDATE ON "r1_report_definition_versions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_definition_versions',json_array(NEW."tenant_id",NEW."definition_id",NEW."version"),'update',json_object('tenant_id',NEW."tenant_id",'definition_id',NEW."definition_id",'version',NEW."version",'digest',NEW."digest",'payload',NEW."payload",'published_by',NEW."published_by",'published_at',NEW."published_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_definition_versions_delete AFTER DELETE ON "r1_report_definition_versions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_definition_versions',json_array(OLD."tenant_id",OLD."definition_id",OLD."version"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_definitions_insert AFTER INSERT ON "r1_report_definitions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_definitions',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'dataset_id',NEW."dataset_id",'org_id',NEW."org_id",'title',NEW."title",'draft',NEW."draft",'revision',NEW."revision",'status',NEW."status",'published_version',NEW."published_version"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_definitions_update AFTER UPDATE ON "r1_report_definitions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_definitions',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'dataset_id',NEW."dataset_id",'org_id',NEW."org_id",'title',NEW."title",'draft',NEW."draft",'revision',NEW."revision",'status',NEW."status",'published_version',NEW."published_version"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_definitions_delete AFTER DELETE ON "r1_report_definitions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_definitions',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_file_intents_insert AFTER INSERT ON "r1_report_file_intents"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'aux:'||lower(hex(randomblob(16)))),'r1_report_file_intents',json_array(NEW."tenant_id",NEW."object_key"),'insert',json_object('tenant_id',NEW."tenant_id",'object_key',NEW."object_key",'job_id',NEW."job_id",'fencing_token',NEW."fencing_token",'created_at',NEW."created_at",'status',NEW."status",'digest',NEW."digest",'byte_count',NEW."byte_count"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_file_intents_update AFTER UPDATE ON "r1_report_file_intents"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'aux:'||lower(hex(randomblob(16)))),'r1_report_file_intents',json_array(NEW."tenant_id",NEW."object_key"),'update',json_object('tenant_id',NEW."tenant_id",'object_key',NEW."object_key",'job_id',NEW."job_id",'fencing_token',NEW."fencing_token",'created_at',NEW."created_at",'status',NEW."status",'digest',NEW."digest",'byte_count',NEW."byte_count"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_file_intents_delete AFTER DELETE ON "r1_report_file_intents"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'aux:'||lower(hex(randomblob(16)))),'r1_report_file_intents',json_array(OLD."tenant_id",OLD."object_key"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_generations_insert AFTER INSERT ON "r1_report_generations"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_generations',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'dataset_id',NEW."dataset_id",'definition_version',NEW."definition_version",'producer_version',NEW."producer_version",'source_manifest',NEW."source_manifest",'source_cutoff',NEW."source_cutoff",'scope_org',NEW."scope_org",'status',NEW."status",'build_cursor',NEW."build_cursor",'revision',NEW."revision",'row_count',NEW."row_count",'content_digest',NEW."content_digest",'created_by',NEW."created_by",'generated_at',NEW."generated_at",'completed_at',NEW."completed_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_generations_update AFTER UPDATE ON "r1_report_generations"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_generations',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'dataset_id',NEW."dataset_id",'definition_version',NEW."definition_version",'producer_version',NEW."producer_version",'source_manifest',NEW."source_manifest",'source_cutoff',NEW."source_cutoff",'scope_org',NEW."scope_org",'status',NEW."status",'build_cursor',NEW."build_cursor",'revision',NEW."revision",'row_count',NEW."row_count",'content_digest',NEW."content_digest",'created_by',NEW."created_by",'generated_at',NEW."generated_at",'completed_at',NEW."completed_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_generations_delete AFTER DELETE ON "r1_report_generations"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_generations',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_job_chunks_insert AFTER INSERT ON "r1_report_job_chunks"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_job_chunks',json_array(NEW."tenant_id",NEW."job_id",NEW."sequence"),'insert',json_object('tenant_id',NEW."tenant_id",'job_id',NEW."job_id",'sequence',NEW."sequence",'object_key',NEW."object_key",'digest',NEW."digest",'row_count',NEW."row_count",'byte_count',NEW."byte_count",'first_key',NEW."first_key",'last_key',NEW."last_key",'fencing_token',NEW."fencing_token"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_job_chunks_update AFTER UPDATE ON "r1_report_job_chunks"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_job_chunks',json_array(NEW."tenant_id",NEW."job_id",NEW."sequence"),'update',json_object('tenant_id',NEW."tenant_id",'job_id',NEW."job_id",'sequence',NEW."sequence",'object_key',NEW."object_key",'digest',NEW."digest",'row_count',NEW."row_count",'byte_count',NEW."byte_count",'first_key',NEW."first_key",'last_key',NEW."last_key",'fencing_token',NEW."fencing_token"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_job_chunks_delete AFTER DELETE ON "r1_report_job_chunks"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_job_chunks',json_array(OLD."tenant_id",OLD."job_id",OLD."sequence"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_jobs_insert AFTER INSERT ON "r1_report_jobs"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_jobs',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'requester_id',NEW."requester_id",'idempotency_key',NEW."idempotency_key",'request_digest',NEW."request_digest",'dataset_id',NEW."dataset_id",'generation_id',NEW."generation_id",'query',NEW."query",'columns_json',NEW."columns_json",'definition_id',NEW."definition_id",'definition_version',NEW."definition_version",'status',NEW."status",'runtime_state',NEW."runtime_state",'revision',NEW."revision",'lease_owner',NEW."lease_owner",'lease_until',NEW."lease_until",'fencing_token',NEW."fencing_token",'next_cursor',NEW."next_cursor",'sequence',NEW."sequence",'row_count',NEW."row_count",'byte_count',NEW."byte_count",'attempt',NEW."attempt",'result_manifest',NEW."result_manifest",'reason_code',NEW."reason_code",'created_at',NEW."created_at",'expires_at',NEW."expires_at",'authorization_revision',NEW."authorization_revision",'scope_revision',NEW."scope_revision",'subscription_id',NEW."subscription_id",'subscription_revision',NEW."subscription_revision",'recipient_id',NEW."recipient_id",'permission_valid_until',NEW."permission_valid_until"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_jobs_update AFTER UPDATE ON "r1_report_jobs"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_jobs',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'requester_id',NEW."requester_id",'idempotency_key',NEW."idempotency_key",'request_digest',NEW."request_digest",'dataset_id',NEW."dataset_id",'generation_id',NEW."generation_id",'query',NEW."query",'columns_json',NEW."columns_json",'definition_id',NEW."definition_id",'definition_version',NEW."definition_version",'status',NEW."status",'runtime_state',NEW."runtime_state",'revision',NEW."revision",'lease_owner',NEW."lease_owner",'lease_until',NEW."lease_until",'fencing_token',NEW."fencing_token",'next_cursor',NEW."next_cursor",'sequence',NEW."sequence",'row_count',NEW."row_count",'byte_count',NEW."byte_count",'attempt',NEW."attempt",'result_manifest',NEW."result_manifest",'reason_code',NEW."reason_code",'created_at',NEW."created_at",'expires_at',NEW."expires_at",'authorization_revision',NEW."authorization_revision",'scope_revision',NEW."scope_revision",'subscription_id',NEW."subscription_id",'subscription_revision',NEW."subscription_revision",'recipient_id',NEW."recipient_id",'permission_valid_until',NEW."permission_valid_until"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_jobs_delete AFTER DELETE ON "r1_report_jobs"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_jobs',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_rows_insert AFTER INSERT ON "r1_report_rows"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_rows',json_array(NEW."tenant_id",NEW."dataset_id",NEW."generation_id",NEW."row_key"),'insert',json_object('tenant_id',NEW."tenant_id",'dataset_id',NEW."dataset_id",'generation_id',NEW."generation_id",'row_key',NEW."row_key",'org_id',NEW."org_id",'person_id',NEW."person_id",'policy_kind',NEW."policy_kind",'policy_key',NEW."policy_key",'event_date',NEW."event_date",'currency',NEW."currency",'cells',NEW."cells",'source_version',NEW."source_version",'key_parts',NEW."key_parts"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_rows_update AFTER UPDATE ON "r1_report_rows"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_rows',json_array(NEW."tenant_id",NEW."dataset_id",NEW."generation_id",NEW."row_key"),'update',json_object('tenant_id',NEW."tenant_id",'dataset_id',NEW."dataset_id",'generation_id',NEW."generation_id",'row_key',NEW."row_key",'org_id',NEW."org_id",'person_id',NEW."person_id",'policy_kind',NEW."policy_kind",'policy_key',NEW."policy_key",'event_date',NEW."event_date",'currency',NEW."currency",'cells',NEW."cells",'source_version',NEW."source_version",'key_parts',NEW."key_parts"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_rows_delete AFTER DELETE ON "r1_report_rows"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_rows',json_array(OLD."tenant_id",OLD."dataset_id",OLD."generation_id",OLD."row_key"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_snapshots_insert AFTER INSERT ON "r1_report_snapshots"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_snapshots',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'dataset_id',NEW."dataset_id",'generation_id',NEW."generation_id",'definition_version',NEW."definition_version",'business_cutoff',NEW."business_cutoff",'generated_at',NEW."generated_at",'source_manifest',NEW."source_manifest",'row_key_schema',NEW."row_key_schema",'row_count',NEW."row_count",'chunk_refs',NEW."chunk_refs",'content_digest',NEW."content_digest",'created_by',NEW."created_by",'purpose',NEW."purpose",'status',NEW."status"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_snapshots_update AFTER UPDATE ON "r1_report_snapshots"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_snapshots',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'dataset_id',NEW."dataset_id",'generation_id',NEW."generation_id",'definition_version',NEW."definition_version",'business_cutoff',NEW."business_cutoff",'generated_at',NEW."generated_at",'source_manifest',NEW."source_manifest",'row_key_schema',NEW."row_key_schema",'row_count',NEW."row_count",'chunk_refs',NEW."chunk_refs",'content_digest',NEW."content_digest",'created_by',NEW."created_by",'purpose',NEW."purpose",'status',NEW."status"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_snapshots_delete AFTER DELETE ON "r1_report_snapshots"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_snapshots',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_subscription_events_insert AFTER INSERT ON "r1_report_subscription_events"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_subscription_events',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'subscription_id',NEW."subscription_id",'revision',NEW."revision",'actor_id',NEW."actor_id",'operation',NEW."operation",'payload',NEW."payload",'at',NEW."at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_subscription_events_update AFTER UPDATE ON "r1_report_subscription_events"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_subscription_events',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'subscription_id',NEW."subscription_id",'revision',NEW."revision",'actor_id',NEW."actor_id",'operation',NEW."operation",'payload',NEW."payload",'at',NEW."at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_subscription_events_delete AFTER DELETE ON "r1_report_subscription_events"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_subscription_events',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_subscription_results_insert AFTER INSERT ON "r1_report_subscription_results"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_subscription_results',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'subscription_id',NEW."subscription_id",'subscription_revision',NEW."subscription_revision",'owner_id',NEW."owner_id",'recipient_id',NEW."recipient_id",'occurrence_at',NEW."occurrence_at",'local_day',NEW."local_day",'local_send_time',NEW."local_send_time",'utc_offset_minutes',NEW."utc_offset_minutes",'channel',NEW."channel",'query_json',NEW."query_json",'generation_id',NEW."generation_id",'manifest',NEW."manifest",'manifest_digest',NEW."manifest_digest",'authorization_revision',NEW."authorization_revision",'scope_revision',NEW."scope_revision",'delivery_state',NEW."delivery_state",'attempt',NEW."attempt",'receipt_id',NEW."receipt_id",'reason_code',NEW."reason_code"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_subscription_results_update AFTER UPDATE ON "r1_report_subscription_results"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_subscription_results',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'subscription_id',NEW."subscription_id",'subscription_revision',NEW."subscription_revision",'owner_id',NEW."owner_id",'recipient_id',NEW."recipient_id",'occurrence_at',NEW."occurrence_at",'local_day',NEW."local_day",'local_send_time',NEW."local_send_time",'utc_offset_minutes',NEW."utc_offset_minutes",'channel',NEW."channel",'query_json',NEW."query_json",'generation_id',NEW."generation_id",'manifest',NEW."manifest",'manifest_digest',NEW."manifest_digest",'authorization_revision',NEW."authorization_revision",'scope_revision',NEW."scope_revision",'delivery_state',NEW."delivery_state",'attempt',NEW."attempt",'receipt_id',NEW."receipt_id",'reason_code',NEW."reason_code"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_subscription_results_delete AFTER DELETE ON "r1_report_subscription_results"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_subscription_results',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_subscriptions_insert AFTER INSERT ON "r1_report_subscriptions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_subscriptions',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'owner_id',NEW."owner_id",'org_id',NEW."org_id",'title',NEW."title",'query_json',NEW."query_json",'recipient_ids',NEW."recipient_ids",'timezone',NEW."timezone",'frequency',NEW."frequency",'week_days',NEW."week_days",'local_send_time',NEW."local_send_time",'gap_policy',NEW."gap_policy",'repeat_policy',NEW."repeat_policy",'start_at',NEW."start_at",'end_at',NEW."end_at",'channel',NEW."channel",'status',NEW."status",'revision',NEW."revision",'proposed_owner',NEW."proposed_owner",'created_at',NEW."created_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_subscriptions_update AFTER UPDATE ON "r1_report_subscriptions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_subscriptions',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'owner_id',NEW."owner_id",'org_id',NEW."org_id",'title',NEW."title",'query_json',NEW."query_json",'recipient_ids',NEW."recipient_ids",'timezone',NEW."timezone",'frequency',NEW."frequency",'week_days',NEW."week_days",'local_send_time',NEW."local_send_time",'gap_policy',NEW."gap_policy",'repeat_policy',NEW."repeat_policy",'start_at',NEW."start_at",'end_at',NEW."end_at",'channel',NEW."channel",'status',NEW."status",'revision',NEW."revision",'proposed_owner',NEW."proposed_owner",'created_at',NEW."created_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_report_subscriptions_delete AFTER DELETE ON "r1_report_subscriptions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_report_subscriptions',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_role_permission_grants_insert AFTER INSERT ON "r1_role_permission_grants"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_role_permission_grants',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'role_id',NEW."role_id",'object_type',NEW."object_type",'action',NEW."action",'relation_type',NEW."relation_type",'scope',NEW."scope",'fields',NEW."fields",'history_mode',NEW."history_mode",'valid_from',NEW."valid_from",'valid_to',NEW."valid_to"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_role_permission_grants_update AFTER UPDATE ON "r1_role_permission_grants"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_role_permission_grants',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'role_id',NEW."role_id",'object_type',NEW."object_type",'action',NEW."action",'relation_type',NEW."relation_type",'scope',NEW."scope",'fields',NEW."fields",'history_mode',NEW."history_mode",'valid_from',NEW."valid_from",'valid_to',NEW."valid_to"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_role_permission_grants_delete AFTER DELETE ON "r1_role_permission_grants"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_role_permission_grants',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_schema_state_insert AFTER INSERT ON "r1_schema_state"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_schema_state',json_array(NEW."tenant_id"),'insert',json_object('tenant_id',NEW."tenant_id",'schema_version',NEW."schema_version",'writer_epoch',NEW."writer_epoch",'recovery_epoch',NEW."recovery_epoch",'authorization_revision',NEW."authorization_revision",'phase',NEW."phase",'open_gate',NEW."open_gate",'features_enabled',NEW."features_enabled",'report_scope_revision',NEW."report_scope_revision"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_schema_state_update AFTER UPDATE ON "r1_schema_state"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_schema_state',json_array(NEW."tenant_id"),'update',json_object('tenant_id',NEW."tenant_id",'schema_version',NEW."schema_version",'writer_epoch',NEW."writer_epoch",'recovery_epoch',NEW."recovery_epoch",'authorization_revision',NEW."authorization_revision",'phase',NEW."phase",'open_gate',NEW."open_gate",'features_enabled',NEW."features_enabled",'report_scope_revision',NEW."report_scope_revision"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_schema_state_delete AFTER DELETE ON "r1_schema_state"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_schema_state',json_array(OLD."tenant_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_source_cursors_insert AFTER INSERT ON "r1_source_cursors"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_source_cursors',json_array(NEW."tenant_id",NEW."source",NEW."entity_id"),'insert',json_object('tenant_id',NEW."tenant_id",'source',NEW."source",'entity_id',NEW."entity_id",'sequence',NEW."sequence"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_source_cursors_update AFTER UPDATE ON "r1_source_cursors"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_source_cursors',json_array(NEW."tenant_id",NEW."source",NEW."entity_id"),'update',json_object('tenant_id',NEW."tenant_id",'source',NEW."source",'entity_id',NEW."entity_id",'sequence',NEW."sequence"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_source_cursors_delete AFTER DELETE ON "r1_source_cursors"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_source_cursors',json_array(OLD."tenant_id",OLD."source",OLD."entity_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_stable_references_insert AFTER INSERT ON "r1_stable_references"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_stable_references',json_array(NEW."tenant_id",NEW."source",NEW."object_type",NEW."external_id",NEW."version"),'insert',json_object('tenant_id',NEW."tenant_id",'source',NEW."source",'object_type',NEW."object_type",'external_id',NEW."external_id",'version',NEW."version",'internal_id',NEW."internal_id",'org_id',NEW."org_id",'label',NEW."label",'raw_status',NEW."raw_status",'mapping_version',NEW."mapping_version",'payload',NEW."payload",'digest',NEW."digest"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_stable_references_update AFTER UPDATE ON "r1_stable_references"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_stable_references',json_array(NEW."tenant_id",NEW."source",NEW."object_type",NEW."external_id",NEW."version"),'update',json_object('tenant_id',NEW."tenant_id",'source',NEW."source",'object_type',NEW."object_type",'external_id',NEW."external_id",'version',NEW."version",'internal_id',NEW."internal_id",'org_id',NEW."org_id",'label',NEW."label",'raw_status',NEW."raw_status",'mapping_version',NEW."mapping_version",'payload',NEW."payload",'digest',NEW."digest"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_stable_references_delete AFTER DELETE ON "r1_stable_references"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_stable_references',json_array(OLD."tenant_id",OLD."source",OLD."object_type",OLD."external_id",OLD."version"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_batch_items_insert AFTER INSERT ON "r1_workflow_batch_items"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_batch_items',json_array(NEW."tenant_id",NEW."batch_id",NEW."item_id"),'insert',json_object('tenant_id',NEW."tenant_id",'batch_id',NEW."batch_id",'item_id',NEW."item_id",'actor_id',NEW."actor_id",'request_digest',NEW."request_digest",'command_id',NEW."command_id",'result',NEW."result"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_batch_items_update AFTER UPDATE ON "r1_workflow_batch_items"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_batch_items',json_array(NEW."tenant_id",NEW."batch_id",NEW."item_id"),'update',json_object('tenant_id',NEW."tenant_id",'batch_id',NEW."batch_id",'item_id',NEW."item_id",'actor_id',NEW."actor_id",'request_digest',NEW."request_digest",'command_id',NEW."command_id",'result',NEW."result"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_batch_items_delete AFTER DELETE ON "r1_workflow_batch_items"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_batch_items',json_array(OLD."tenant_id",OLD."batch_id",OLD."item_id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_batches_insert AFTER INSERT ON "r1_workflow_batches"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_batches',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'actor_id',NEW."actor_id",'digest',NEW."digest",'created_at',NEW."created_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_batches_update AFTER UPDATE ON "r1_workflow_batches"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_batches',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'actor_id',NEW."actor_id",'digest',NEW."digest",'created_at',NEW."created_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_batches_delete AFTER DELETE ON "r1_workflow_batches"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_batches',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_decisions_insert AFTER INSERT ON "r1_workflow_decisions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_decisions',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'node_id',NEW."node_id",'node_revision',NEW."node_revision",'actor_id',NEW."actor_id",'decision',NEW."decision",'reason',NEW."reason",'at',NEW."at",'command_id',NEW."command_id",'digest',NEW."digest",'actor_name',NEW."actor_name"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_decisions_update AFTER UPDATE ON "r1_workflow_decisions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_decisions',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'node_id',NEW."node_id",'node_revision',NEW."node_revision",'actor_id',NEW."actor_id",'decision',NEW."decision",'reason',NEW."reason",'at',NEW."at",'command_id',NEW."command_id",'digest',NEW."digest",'actor_name',NEW."actor_name"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_decisions_delete AFTER DELETE ON "r1_workflow_decisions"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_decisions',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_denials_insert AFTER INSERT ON "r1_workflow_denials"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'aux:'||lower(hex(randomblob(16)))),'r1_workflow_denials',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'actor_id',NEW."actor_id",'command_id',NEW."command_id",'action',NEW."action",'reason_code',NEW."reason_code",'authorization_revision',NEW."authorization_revision",'at',NEW."at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_denials_update AFTER UPDATE ON "r1_workflow_denials"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'aux:'||lower(hex(randomblob(16)))),'r1_workflow_denials',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'actor_id',NEW."actor_id",'command_id',NEW."command_id",'action',NEW."action",'reason_code',NEW."reason_code",'authorization_revision',NEW."authorization_revision",'at',NEW."at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_denials_delete AFTER DELETE ON "r1_workflow_denials"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'aux:'||lower(hex(randomblob(16)))),'r1_workflow_denials',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_events_insert AFTER INSERT ON "r1_workflow_events"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_events',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'instance_id',NEW."instance_id",'action',NEW."action",'actor_id',NEW."actor_id",'principal_id',NEW."principal_id",'delegation_id',NEW."delegation_id",'payload',NEW."payload",'at',NEW."at",'command_id',NEW."command_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_events_update AFTER UPDATE ON "r1_workflow_events"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_events',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'instance_id',NEW."instance_id",'action',NEW."action",'actor_id',NEW."actor_id",'principal_id',NEW."principal_id",'delegation_id',NEW."delegation_id",'payload',NEW."payload",'at',NEW."at",'command_id',NEW."command_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_events_delete AFTER DELETE ON "r1_workflow_events"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_events',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_instances_insert AFTER INSERT ON "r1_workflow_instances"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_instances',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'business_type',NEW."business_type",'business_id',NEW."business_id",'application_version',NEW."application_version",'request_digest',NEW."request_digest",'org_id',NEW."org_id",'person_id',NEW."person_id",'title',NEW."title",'initiator_id',NEW."initiator_id",'revision',NEW."revision",'generation',NEW."generation",'approval_status',NEW."approval_status",'effect_status',NEW."effect_status",'current_node_id',NEW."current_node_id",'source_revision',NEW."source_revision",'template_payload',NEW."template_payload",'created_at',NEW."created_at",'updated_at',NEW."updated_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_instances_update AFTER UPDATE ON "r1_workflow_instances"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_instances',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'business_type',NEW."business_type",'business_id',NEW."business_id",'application_version',NEW."application_version",'request_digest',NEW."request_digest",'org_id',NEW."org_id",'person_id',NEW."person_id",'title',NEW."title",'initiator_id',NEW."initiator_id",'revision',NEW."revision",'generation',NEW."generation",'approval_status',NEW."approval_status",'effect_status',NEW."effect_status",'current_node_id',NEW."current_node_id",'source_revision',NEW."source_revision",'template_payload',NEW."template_payload",'created_at',NEW."created_at",'updated_at',NEW."updated_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_instances_delete AFTER DELETE ON "r1_workflow_instances"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_instances',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_nodes_insert AFTER INSERT ON "r1_workflow_nodes"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_nodes',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'instance_id',NEW."instance_id",'node_key',NEW."node_key",'revision',NEW."revision",'generation',NEW."generation",'status',NEW."status",'assignees',NEW."assignees",'policy',NEW."policy"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_nodes_update AFTER UPDATE ON "r1_workflow_nodes"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_nodes',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'instance_id',NEW."instance_id",'node_key',NEW."node_key",'revision',NEW."revision",'generation',NEW."generation",'status',NEW."status",'assignees',NEW."assignees",'policy',NEW."policy"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_nodes_delete AFTER DELETE ON "r1_workflow_nodes"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_nodes',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_notifications_insert AFTER INSERT ON "r1_workflow_notifications"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_notifications',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'instance_id',NEW."instance_id",'node_id',NEW."node_id",'node_revision',NEW."node_revision",'recipient_id',NEW."recipient_id",'template_version',NEW."template_version",'status',NEW."status",'attempt',NEW."attempt",'provider_receipt_id',NEW."provider_receipt_id",'digest',NEW."digest"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_notifications_update AFTER UPDATE ON "r1_workflow_notifications"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_notifications',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'instance_id',NEW."instance_id",'node_id',NEW."node_id",'node_revision',NEW."node_revision",'recipient_id',NEW."recipient_id",'template_version',NEW."template_version",'status',NEW."status",'attempt',NEW."attempt",'provider_receipt_id',NEW."provider_receipt_id",'digest',NEW."digest"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_notifications_delete AFTER DELETE ON "r1_workflow_notifications"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_notifications',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_roots_insert AFTER INSERT ON "r1_workflow_roots"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_roots',json_array(NEW."tenant_id",NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'business_type',NEW."business_type",'current_version',NEW."current_version",'disabled',NEW."disabled",'org_id',NEW."org_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_roots_update AFTER UPDATE ON "r1_workflow_roots"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_roots',json_array(NEW."tenant_id",NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'business_type',NEW."business_type",'current_version',NEW."current_version",'disabled',NEW."disabled",'org_id',NEW."org_id"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_roots_delete AFTER DELETE ON "r1_workflow_roots"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_roots',json_array(OLD."tenant_id",OLD."id"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_templates_insert AFTER INSERT ON "r1_workflow_templates"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_templates',json_array(NEW."tenant_id",NEW."id",NEW."version"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'version',NEW."version",'digest',NEW."digest",'payload',NEW."payload",'published_at',NEW."published_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_templates_update AFTER UPDATE ON "r1_workflow_templates"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(NEW.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_templates',json_array(NEW."tenant_id",NEW."id",NEW."version"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'version',NEW."version",'digest',NEW."digest",'payload',NEW."payload",'published_at',NEW."published_at"),coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=NEW.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=NEW.tenant_id),0));
END;
CREATE TRIGGER r1_log_r1_workflow_templates_delete AFTER DELETE ON "r1_workflow_templates"
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 VALUES(OLD.tenant_id,coalesce((SELECT w.last_mutation FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing'),'unfenced:'||lower(hex(randomblob(16)))),'r1_workflow_templates',json_array(OLD."tenant_id",OLD."id",OLD."version"),'delete',NULL,coalesce((SELECT schema_version FROM r1_schema_state WHERE tenant_id=OLD.tenant_id),1),coalesce((SELECT revision FROM hris_workspaces WHERE owner=OLD.tenant_id),0));
END;
