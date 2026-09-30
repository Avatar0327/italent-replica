-- Compatibility changes invalidate reconciliation; no destructive rollback.
ALTER TABLE r1_schema_state ADD COLUMN migration_source_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE r1_migration_runs ADD COLUMN scan_generation INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER r1_migration_dirty_hris_audit_events_insert AFTER INSERT ON hris_audit_events WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') AND NEW.action NOT LIKE 'BASE.migration.%' BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_audit_events' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_audit_events_update AFTER UPDATE ON hris_audit_events WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') AND NEW.action NOT LIKE 'BASE.migration.%' BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_audit_events' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_audit_events_delete AFTER DELETE ON hris_audit_events WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') AND OLD.action NOT LIKE 'BASE.migration.%' BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_audit_events' AND source_key=json_array(OLD.tenant_id,OLD.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_memberships_insert AFTER INSERT ON hris_memberships WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_memberships' AND source_key=json_array(NEW.user_id);
END;
CREATE TRIGGER r1_migration_dirty_hris_memberships_update AFTER UPDATE ON hris_memberships WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_memberships' AND source_key=json_array(NEW.user_id);
END;
CREATE TRIGGER r1_migration_dirty_hris_memberships_delete AFTER DELETE ON hris_memberships WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_memberships' AND source_key=json_array(OLD.user_id);
END;
CREATE TRIGGER r1_migration_dirty_hris_access_grants_insert AFTER INSERT ON hris_access_grants WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_access_grants' AND source_key=json_array(NEW.email);
END;
CREATE TRIGGER r1_migration_dirty_hris_access_grants_update AFTER UPDATE ON hris_access_grants WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_access_grants' AND source_key=json_array(NEW.email);
END;
CREATE TRIGGER r1_migration_dirty_hris_access_grants_delete AFTER DELETE ON hris_access_grants WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_access_grants' AND source_key=json_array(OLD.email);
END;
CREATE TRIGGER r1_migration_dirty_hris_installation_insert AFTER INSERT ON hris_installation WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_installation' AND source_key=json_array(NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_installation_update AFTER UPDATE ON hris_installation WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_installation' AND source_key=json_array(NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_installation_delete AFTER DELETE ON hris_installation WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_installation' AND source_key=json_array(OLD.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_approval_steps_insert AFTER INSERT ON hris_approval_steps WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_approval_steps' AND source_key=json_array(NEW.tenant_id,NEW.approval_id,NEW.position);
END;
CREATE TRIGGER r1_migration_dirty_hris_approval_steps_update AFTER UPDATE ON hris_approval_steps WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_approval_steps' AND source_key=json_array(NEW.tenant_id,NEW.approval_id,NEW.position);
END;
CREATE TRIGGER r1_migration_dirty_hris_approval_steps_delete AFTER DELETE ON hris_approval_steps WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_approval_steps' AND source_key=json_array(OLD.tenant_id,OLD.approval_id,OLD.position);
END;
CREATE TRIGGER r1_migration_dirty_hris_approvals_insert AFTER INSERT ON hris_approvals WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_approvals' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_approvals_update AFTER UPDATE ON hris_approvals WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_approvals' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_approvals_delete AFTER DELETE ON hris_approvals WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_approvals' AND source_key=json_array(OLD.tenant_id,OLD.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_employees_insert AFTER INSERT ON hris_employees WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_employees' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_employees_update AFTER UPDATE ON hris_employees WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_employees' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_employees_delete AFTER DELETE ON hris_employees WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_employees' AND source_key=json_array(OLD.tenant_id,OLD.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_employment_history_insert AFTER INSERT ON hris_employment_history WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_employment_history' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_employment_history_update AFTER UPDATE ON hris_employment_history WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_employment_history' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_employment_history_delete AFTER DELETE ON hris_employment_history WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_employment_history' AND source_key=json_array(OLD.tenant_id,OLD.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_orgs_insert AFTER INSERT ON hris_orgs WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_orgs' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_orgs_update AFTER UPDATE ON hris_orgs WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_orgs' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_orgs_delete AFTER DELETE ON hris_orgs WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_orgs' AND source_key=json_array(OLD.tenant_id,OLD.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_workflow_steps_insert AFTER INSERT ON hris_workflow_steps WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_workflow_steps' AND source_key=json_array(NEW.tenant_id,NEW.kind,NEW.version,NEW.position);
END;
CREATE TRIGGER r1_migration_dirty_hris_workflow_steps_update AFTER UPDATE ON hris_workflow_steps WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_workflow_steps' AND source_key=json_array(NEW.tenant_id,NEW.kind,NEW.version,NEW.position);
END;
CREATE TRIGGER r1_migration_dirty_hris_workflow_steps_delete AFTER DELETE ON hris_workflow_steps WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_workflow_steps' AND source_key=json_array(OLD.tenant_id,OLD.kind,OLD.version,OLD.position);
END;
CREATE TRIGGER r1_migration_dirty_hris_workflows_insert AFTER INSERT ON hris_workflows WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_workflows' AND source_key=json_array(NEW.tenant_id,NEW.kind,NEW.version);
END;
CREATE TRIGGER r1_migration_dirty_hris_workflows_update AFTER UPDATE ON hris_workflows WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_workflows' AND source_key=json_array(NEW.tenant_id,NEW.kind,NEW.version);
END;
CREATE TRIGGER r1_migration_dirty_hris_workflows_delete AFTER DELETE ON hris_workflows WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_workflows' AND source_key=json_array(OLD.tenant_id,OLD.kind,OLD.version);
END;
CREATE TRIGGER r1_migration_dirty_hris_assignment_requests_insert AFTER INSERT ON hris_assignment_requests WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_assignment_requests' AND source_key=json_array(NEW.tenant_id,NEW.approval_id);
END;
CREATE TRIGGER r1_migration_dirty_hris_assignment_requests_update AFTER UPDATE ON hris_assignment_requests WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_assignment_requests' AND source_key=json_array(NEW.tenant_id,NEW.approval_id);
END;
CREATE TRIGGER r1_migration_dirty_hris_assignment_requests_delete AFTER DELETE ON hris_assignment_requests WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_assignment_requests' AND source_key=json_array(OLD.tenant_id,OLD.approval_id);
END;
CREATE TRIGGER r1_migration_dirty_hris_employee_positions_insert AFTER INSERT ON hris_employee_positions WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_employee_positions' AND source_key=json_array(NEW.tenant_id,NEW.employee_id);
END;
CREATE TRIGGER r1_migration_dirty_hris_employee_positions_update AFTER UPDATE ON hris_employee_positions WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_employee_positions' AND source_key=json_array(NEW.tenant_id,NEW.employee_id);
END;
CREATE TRIGGER r1_migration_dirty_hris_employee_positions_delete AFTER DELETE ON hris_employee_positions WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_employee_positions' AND source_key=json_array(OLD.tenant_id,OLD.employee_id);
END;
CREATE TRIGGER r1_migration_dirty_hris_grades_insert AFTER INSERT ON hris_grades WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_grades' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_grades_update AFTER UPDATE ON hris_grades WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_grades' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_grades_delete AFTER DELETE ON hris_grades WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_grades' AND source_key=json_array(OLD.tenant_id,OLD.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_positions_insert AFTER INSERT ON hris_positions WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_positions' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_positions_update AFTER UPDATE ON hris_positions WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_positions' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_positions_delete AFTER DELETE ON hris_positions WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_positions' AND source_key=json_array(OLD.tenant_id,OLD.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_attachments_insert AFTER INSERT ON hris_attachments WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_attachments' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_attachments_update AFTER UPDATE ON hris_attachments WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_attachments' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_attachments_delete AFTER DELETE ON hris_attachments WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_attachments' AND source_key=json_array(OLD.tenant_id,OLD.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_development_records_insert AFTER INSERT ON hris_development_records WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_development_records' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_development_records_update AFTER UPDATE ON hris_development_records WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_development_records' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_development_records_delete AFTER DELETE ON hris_development_records WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_development_records' AND source_key=json_array(OLD.tenant_id,OLD.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_development_events_insert AFTER INSERT ON hris_development_events WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_development_events' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_development_events_update AFTER UPDATE ON hris_development_events WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=NEW.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=NEW.tenant_id AND source_table='hris_development_events' AND source_key=json_array(NEW.tenant_id,NEW.id);
END;
CREATE TRIGGER r1_migration_dirty_hris_development_events_delete AFTER DELETE ON hris_development_events WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=OLD.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%') BEGIN
 UPDATE r1_schema_state SET migration_source_revision=migration_source_revision+1 WHERE tenant_id=OLD.tenant_id;
 UPDATE r1_migration_map SET source_digest='',confidence='source_changed' WHERE tenant_id=OLD.tenant_id AND source_table='hris_development_events' AND source_key=json_array(OLD.tenant_id,OLD.id);
END;
CREATE TRIGGER r1_migration_require_map_hris_employees BEFORE UPDATE ON hris_employees WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%' AND c.action NOT LIKE 'M01.%' AND c.action NOT LIKE 'M19.%') AND EXISTS(SELECT 1 FROM r1_migration_runs WHERE tenant_id=NEW.tenant_id AND phase IN ('backfilling','reconciling')) AND NOT EXISTS(SELECT 1 FROM r1_m01_entities WHERE tenant_id=NEW.tenant_id AND kind='person' AND id=NEW.id) BEGIN SELECT RAISE(ABORT,'MIGRATION_OBJECT_NOT_BACKFILLED'); END;
CREATE TRIGGER r1_migration_protect_multi_assignment BEFORE UPDATE ON hris_employees WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%' AND c.action NOT LIKE 'M01.%' AND c.action NOT LIKE 'M19.%') AND EXISTS(SELECT 1 FROM r1_m01_entities WHERE tenant_id=NEW.tenant_id AND kind='assignment' AND person_id=NEW.id AND (COALESCE(json_extract(payload,'$.migrationObservation'),0)<>1 OR json_extract(payload,'$.type')<>'primary')) BEGIN SELECT RAISE(ABORT,'MIGRATION_NEW_FACTS_REQUIRE_NEW_CLIENT'); END;
CREATE TRIGGER r1_migration_bridge_hris_employees AFTER UPDATE ON hris_employees WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%' AND c.action NOT LIKE 'M01.%' AND c.action NOT LIKE 'M19.%') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM r1_m01_entities WHERE tenant_id=NEW.tenant_id AND kind='person' AND id=NEW.id AND COALESCE(json_extract(payload,'$.migrationObservation'),0)<>1) THEN RAISE(ABORT,'MIGRATION_NEW_FACTS_REQUIRE_NEW_CLIENT') END;
 UPDATE r1_m01_entities SET revision=revision+1,org_id=NEW.org_id,code=NEW.code,status=CASE WHEN NEW.status='离职' THEN 'ended' ELSE 'active' END,payload=json_set(payload,'$.name',NEW.name,'$.fields.email',NULLIF(NEW.email,''),'$.fields.level',NULLIF(NEW.level,''),'$.legacyStatus',NEW.status) WHERE tenant_id=NEW.tenant_id AND kind='person' AND id=NEW.id AND json_extract(payload,'$.migrationObservation')=1;
 INSERT INTO r1_m01_versions SELECT e.tenant_id,e.id,e.revision,w.revision,c.command_id,c.created_at,json_extract(e.payload,'$.validFrom'),json_extract(e.payload,'$.validTo'),'migration_bridge_observation',json_object('id',e.id,'kind',e.kind,'personId',e.person_id,'orgId',e.org_id,'code',e.code,'revision',e.revision,'status',e.status,'payload',json(e.payload)) FROM r1_m01_entities e JOIN hris_workspaces w ON w.owner=e.tenant_id JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE e.tenant_id=NEW.tenant_id AND kind='person' AND id=NEW.id AND json_extract(e.payload,'$.migrationObservation')=1;
END;
CREATE TRIGGER r1_migration_protect_delete_hris_employees BEFORE DELETE ON hris_employees WHEN EXISTS(SELECT 1 FROM r1_migration_map WHERE tenant_id=OLD.tenant_id AND source_table='hris_employees') BEGIN SELECT RAISE(ABORT,'MIGRATION_FACT_DELETE_REQUIRES_LIFECYCLE'); END;
CREATE TRIGGER r1_migration_require_map_hris_orgs BEFORE UPDATE ON hris_orgs WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%' AND c.action NOT LIKE 'M01.%' AND c.action NOT LIKE 'M19.%') AND EXISTS(SELECT 1 FROM r1_migration_runs WHERE tenant_id=NEW.tenant_id AND phase IN ('backfilling','reconciling')) AND NOT EXISTS(SELECT 1 FROM r1_m01_entities WHERE tenant_id=NEW.tenant_id AND kind='org' AND id=NEW.id) BEGIN SELECT RAISE(ABORT,'MIGRATION_OBJECT_NOT_BACKFILLED'); END;
CREATE TRIGGER r1_migration_bridge_hris_orgs AFTER UPDATE ON hris_orgs WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%' AND c.action NOT LIKE 'M01.%' AND c.action NOT LIKE 'M19.%') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM r1_m01_entities WHERE tenant_id=NEW.tenant_id AND kind='org' AND id=NEW.id AND COALESCE(json_extract(payload,'$.migrationObservation'),0)<>1) THEN RAISE(ABORT,'MIGRATION_NEW_FACTS_REQUIRE_NEW_CLIENT') END;
 UPDATE r1_m01_entities SET revision=revision+1,status=CASE WHEN NEW.status='启用' THEN 'active' ELSE 'inactive' END,payload=json_set(payload,'$.name',NEW.name,'$.parentId',COALESCE(NEW.parent_id,''),'$.attributes.city',NEW.city,'$.attributes.legacyLeader',NEW.leader) WHERE tenant_id=NEW.tenant_id AND kind='org' AND id=NEW.id AND json_extract(payload,'$.migrationObservation')=1;
 INSERT INTO r1_m01_versions SELECT e.tenant_id,e.id,e.revision,w.revision,c.command_id,c.created_at,json_extract(e.payload,'$.validFrom'),json_extract(e.payload,'$.validTo'),'migration_bridge_observation',json_object('id',e.id,'kind',e.kind,'personId',e.person_id,'orgId',e.org_id,'code',e.code,'revision',e.revision,'status',e.status,'payload',json(e.payload)) FROM r1_m01_entities e JOIN hris_workspaces w ON w.owner=e.tenant_id JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE e.tenant_id=NEW.tenant_id AND kind='org' AND id=NEW.id AND json_extract(e.payload,'$.migrationObservation')=1;
END;
CREATE TRIGGER r1_migration_protect_delete_hris_orgs BEFORE DELETE ON hris_orgs WHEN EXISTS(SELECT 1 FROM r1_migration_map WHERE tenant_id=OLD.tenant_id AND source_table='hris_orgs') BEGIN SELECT RAISE(ABORT,'MIGRATION_FACT_DELETE_REQUIRES_LIFECYCLE'); END;
CREATE TRIGGER r1_migration_require_map_hris_positions BEFORE UPDATE ON hris_positions WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%' AND c.action NOT LIKE 'M01.%' AND c.action NOT LIKE 'M19.%') AND EXISTS(SELECT 1 FROM r1_migration_runs WHERE tenant_id=NEW.tenant_id AND phase IN ('backfilling','reconciling')) AND NOT EXISTS(SELECT 1 FROM r1_m01_entities WHERE tenant_id=NEW.tenant_id AND kind='position' AND id=NEW.id) BEGIN SELECT RAISE(ABORT,'MIGRATION_OBJECT_NOT_BACKFILLED'); END;
CREATE TRIGGER r1_migration_bridge_hris_positions AFTER UPDATE ON hris_positions WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%' AND c.action NOT LIKE 'M01.%' AND c.action NOT LIKE 'M19.%') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM r1_m01_entities WHERE tenant_id=NEW.tenant_id AND kind='position' AND id=NEW.id AND COALESCE(json_extract(payload,'$.migrationObservation'),0)<>1) THEN RAISE(ABORT,'MIGRATION_NEW_FACTS_REQUIRE_NEW_CLIENT') END;
 UPDATE r1_m01_entities SET revision=revision+1,org_id=NEW.org_id,status=CASE WHEN NEW.status='启用' THEN 'active' ELSE 'inactive' END,payload=json_set(payload,'$.name',NEW.name,'$.attributes.legacyFamilyLabel',NEW.family,'$.attributes.responsibilities',NEW.responsibilities) WHERE tenant_id=NEW.tenant_id AND kind='position' AND id=NEW.id AND json_extract(payload,'$.migrationObservation')=1;
 INSERT INTO r1_m01_versions SELECT e.tenant_id,e.id,e.revision,w.revision,c.command_id,c.created_at,json_extract(e.payload,'$.validFrom'),json_extract(e.payload,'$.validTo'),'migration_bridge_observation',json_object('id',e.id,'kind',e.kind,'personId',e.person_id,'orgId',e.org_id,'code',e.code,'revision',e.revision,'status',e.status,'payload',json(e.payload)) FROM r1_m01_entities e JOIN hris_workspaces w ON w.owner=e.tenant_id JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE e.tenant_id=NEW.tenant_id AND kind='position' AND id=NEW.id AND json_extract(e.payload,'$.migrationObservation')=1;
END;
CREATE TRIGGER r1_migration_protect_delete_hris_positions BEFORE DELETE ON hris_positions WHEN EXISTS(SELECT 1 FROM r1_migration_map WHERE tenant_id=OLD.tenant_id AND source_table='hris_positions') BEGIN SELECT RAISE(ABORT,'MIGRATION_FACT_DELETE_REQUIRES_LIFECYCLE'); END;
CREATE TRIGGER r1_migration_require_map_hris_grades BEFORE UPDATE ON hris_grades WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%' AND c.action NOT LIKE 'M01.%' AND c.action NOT LIKE 'M19.%') AND EXISTS(SELECT 1 FROM r1_migration_runs WHERE tenant_id=NEW.tenant_id AND phase IN ('backfilling','reconciling')) AND NOT EXISTS(SELECT 1 FROM r1_m01_entities WHERE tenant_id=NEW.tenant_id AND kind='grade' AND id=NEW.id) BEGIN SELECT RAISE(ABORT,'MIGRATION_OBJECT_NOT_BACKFILLED'); END;
CREATE TRIGGER r1_migration_bridge_hris_grades AFTER UPDATE ON hris_grades WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%' AND c.action NOT LIKE 'M01.%' AND c.action NOT LIKE 'M19.%') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM r1_m01_entities WHERE tenant_id=NEW.tenant_id AND kind='grade' AND id=NEW.id AND COALESCE(json_extract(payload,'$.migrationObservation'),0)<>1) THEN RAISE(ABORT,'MIGRATION_NEW_FACTS_REQUIRE_NEW_CLIENT') END;
 UPDATE r1_m01_entities SET revision=revision+1,status=CASE WHEN NEW.status='启用' THEN 'active' ELSE 'inactive' END,payload=json_set(payload,'$.name',NEW.name,'$.attributes.sequence',NEW.sequence) WHERE tenant_id=NEW.tenant_id AND kind='grade' AND id=NEW.id AND json_extract(payload,'$.migrationObservation')=1;
 INSERT INTO r1_m01_versions SELECT e.tenant_id,e.id,e.revision,w.revision,c.command_id,c.created_at,json_extract(e.payload,'$.validFrom'),json_extract(e.payload,'$.validTo'),'migration_bridge_observation',json_object('id',e.id,'kind',e.kind,'personId',e.person_id,'orgId',e.org_id,'code',e.code,'revision',e.revision,'status',e.status,'payload',json(e.payload)) FROM r1_m01_entities e JOIN hris_workspaces w ON w.owner=e.tenant_id JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE e.tenant_id=NEW.tenant_id AND kind='grade' AND id=NEW.id AND json_extract(e.payload,'$.migrationObservation')=1;
END;
CREATE TRIGGER r1_migration_protect_delete_hris_grades BEFORE DELETE ON hris_grades WHEN EXISTS(SELECT 1 FROM r1_migration_map WHERE tenant_id=OLD.tenant_id AND source_table='hris_grades') BEGIN SELECT RAISE(ABORT,'MIGRATION_FACT_DELETE_REQUIRES_LIFECYCLE'); END;
CREATE TRIGGER r1_migration_require_map_hris_employee_positions BEFORE UPDATE ON hris_employee_positions WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%' AND c.action NOT LIKE 'M01.%' AND c.action NOT LIKE 'M19.%') AND EXISTS(SELECT 1 FROM r1_migration_runs WHERE tenant_id=NEW.tenant_id AND phase IN ('backfilling','reconciling')) AND NOT EXISTS(SELECT 1 FROM r1_m01_entities WHERE tenant_id=NEW.tenant_id AND kind='assignment' AND person_id=NEW.employee_id AND json_extract(payload,'$.type')='primary') BEGIN SELECT RAISE(ABORT,'MIGRATION_OBJECT_NOT_BACKFILLED'); END;
CREATE TRIGGER r1_migration_bridge_hris_employee_positions AFTER UPDATE ON hris_employee_positions WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%' AND c.action NOT LIKE 'M01.%' AND c.action NOT LIKE 'M19.%') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM r1_m01_entities WHERE tenant_id=NEW.tenant_id AND kind='assignment' AND person_id=NEW.employee_id AND json_extract(payload,'$.type')='primary' AND COALESCE(json_extract(payload,'$.migrationObservation'),0)<>1) THEN RAISE(ABORT,'MIGRATION_NEW_FACTS_REQUIRE_NEW_CLIENT') END;
 UPDATE r1_m01_entities SET revision=revision+1,payload=json_set(payload,'$.positionId',NEW.position_id,'$.gradeId',NEW.grade_id) WHERE tenant_id=NEW.tenant_id AND kind='assignment' AND person_id=NEW.employee_id AND json_extract(payload,'$.type')='primary' AND json_extract(payload,'$.migrationObservation')=1;
 INSERT INTO r1_m01_versions SELECT e.tenant_id,e.id,e.revision,w.revision,c.command_id,c.created_at,json_extract(e.payload,'$.validFrom'),json_extract(e.payload,'$.validTo'),'migration_bridge_observation',json_object('id',e.id,'kind',e.kind,'personId',e.person_id,'orgId',e.org_id,'code',e.code,'revision',e.revision,'status',e.status,'payload',json(e.payload)) FROM r1_m01_entities e JOIN hris_workspaces w ON w.owner=e.tenant_id JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE e.tenant_id=NEW.tenant_id AND kind='assignment' AND person_id=NEW.employee_id AND json_extract(payload,'$.type')='primary' AND json_extract(e.payload,'$.migrationObservation')=1;
END;
CREATE TRIGGER r1_migration_protect_delete_hris_employee_positions BEFORE DELETE ON hris_employee_positions WHEN EXISTS(SELECT 1 FROM r1_migration_map WHERE tenant_id=OLD.tenant_id AND source_table='hris_employee_positions') BEGIN SELECT RAISE(ABORT,'MIGRATION_FACT_DELETE_REQUIRES_LIFECYCLE'); END;
CREATE TRIGGER r1_migration_employee_companions AFTER UPDATE ON hris_employees WHEN EXISTS(SELECT 1 FROM hris_workspaces w JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE w.owner=NEW.tenant_id AND c.status='processing' AND c.action NOT LIKE 'BASE.migration.%' AND c.action NOT LIKE 'M01.%' AND c.action NOT LIKE 'M19.%') BEGIN
 UPDATE r1_m01_entities SET revision=revision+1,org_id=NEW.org_id,status=CASE WHEN NEW.status='离职' THEN 'ended' ELSE 'active' END,payload=CASE WHEN kind='employment' THEN json_set(payload,'$.legacyJoined',NEW.joined,'$.startOn',CASE WHEN date(NEW.joined)=NEW.joined THEN NEW.joined ELSE NULL END) ELSE json_set(payload,'$.legacyJobLabel',NEW.job,'$.legacyLevelLabel',NEW.level,'$.occupancy',CASE WHEN NEW.status='离职' THEN 0 ELSE 1 END) END WHERE tenant_id=NEW.tenant_id AND person_id=NEW.id AND kind IN ('employment','assignment') AND json_extract(payload,'$.migrationObservation')=1;
 INSERT INTO r1_m01_versions SELECT e.tenant_id,e.id,e.revision,w.revision,c.command_id,c.created_at,json_extract(e.payload,'$.validFrom'),json_extract(e.payload,'$.validTo'),'migration_bridge_observation',json_object('id',e.id,'kind',e.kind,'personId',e.person_id,'orgId',e.org_id,'code',e.code,'revision',e.revision,'status',e.status,'payload',json(e.payload)) FROM r1_m01_entities e JOIN hris_workspaces w ON w.owner=e.tenant_id JOIN r1_commands c ON c.tenant_id=w.owner AND c.token=w.last_mutation WHERE e.tenant_id=NEW.tenant_id AND e.person_id=NEW.id AND e.kind IN ('employment','assignment') AND json_extract(e.payload,'$.migrationObservation')=1;
END;
