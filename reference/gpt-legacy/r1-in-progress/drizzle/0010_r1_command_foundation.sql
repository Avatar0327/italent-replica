-- R1 expansion only. No production execution authorized. New capabilities remain off.
CREATE TABLE r1_schema_state (
 tenant_id TEXT PRIMARY KEY REFERENCES hris_workspaces(owner),
 schema_version INTEGER NOT NULL DEFAULT 1,
 writer_epoch INTEGER NOT NULL DEFAULT 1,
 recovery_epoch INTEGER NOT NULL DEFAULT 1,
 authorization_revision INTEGER NOT NULL DEFAULT 1,
 phase TEXT NOT NULL DEFAULT 'writers_guarded',
 open_gate INTEGER NOT NULL DEFAULT 1 CHECK(open_gate IN (0,1)),
 features_enabled INTEGER NOT NULL DEFAULT 0 CHECK(features_enabled IN (0,1))
);
INSERT INTO r1_schema_state(tenant_id) SELECT owner FROM hris_workspaces;
CREATE TABLE r1_commands (
 tenant_id TEXT NOT NULL REFERENCES hris_workspaces(owner), command_id TEXT NOT NULL,
 actor_id TEXT NOT NULL, action TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 request_digest TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('processing','committed','rejected','archived')),
 workspace_revision INTEGER NOT NULL, authorization_revision INTEGER NOT NULL,
 writer_epoch INTEGER NOT NULL,recovery_epoch INTEGER NOT NULL,
 result TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,command_id), UNIQUE(tenant_id,actor_id,action,idempotency_key)
);
CREATE TABLE r1_outbox (
 tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, command_id TEXT NOT NULL,
 event_type TEXT NOT NULL, workspace_revision INTEGER NOT NULL, payload TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(tenant_id,event_id),
 FOREIGN KEY(tenant_id,command_id) REFERENCES r1_commands(tenant_id,command_id)
);
CREATE TABLE r1_recovery_changes (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,tx_id TEXT NOT NULL,
 table_name TEXT NOT NULL,row_key TEXT NOT NULL,operation TEXT NOT NULL,
 after_image TEXT,schema_version INTEGER NOT NULL,workspace_revision INTEGER NOT NULL
);
CREATE INDEX r1_recovery_tenant_seq ON r1_recovery_changes(tenant_id,seq);
CREATE TABLE r1_permission_grants (
 tenant_id TEXT NOT NULL REFERENCES hris_workspaces(owner),id TEXT NOT NULL,
 member_id TEXT NOT NULL,object_type TEXT NOT NULL,action TEXT NOT NULL,
 relation_type TEXT NOT NULL,scope TEXT NOT NULL,fields TEXT NOT NULL,
 history_mode TEXT NOT NULL,valid_from TEXT NOT NULL,valid_to TEXT,
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX r1_grants_member_action ON r1_permission_grants(tenant_id,member_id,object_type,action);
CREATE TABLE r1_relationships (
 tenant_id TEXT NOT NULL REFERENCES hris_workspaces(owner),id TEXT NOT NULL,
 manager_person_id TEXT NOT NULL,subject_person_id TEXT NOT NULL,
 relation_type TEXT NOT NULL,valid_from TEXT NOT NULL,valid_to TEXT,
 source_version TEXT NOT NULL, PRIMARY KEY(tenant_id,id)
);
CREATE INDEX r1_relationship_subject ON r1_relationships(tenant_id,manager_person_id,subject_person_id);
CREATE TRIGGER r1_workspace_writer_guard BEFORE UPDATE ON hris_workspaces
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.owner)
BEGIN
 SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM r1_commands c JOIN r1_schema_state s ON s.tenant_id=c.tenant_id
 WHERE c.tenant_id=OLD.owner AND c.token=NEW.last_mutation AND c.status='processing'
 AND c.workspace_revision=OLD.revision AND NEW.revision=OLD.revision+1
 AND c.authorization_revision=s.authorization_revision AND c.writer_epoch=s.writer_epoch
 AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1
 AND s.phase IN ('writers_guarded','backfilling','reconciling','read_switched','features_enabled','monitored')
 ) THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_log_hris_workspaces_insert AFTER INSERT ON hris_workspaces
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.owner)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_workspaces',json_object('owner',NEW."owner"),'insert',json_object('owner',NEW."owner",'revision',NEW."revision",'data',NEW."data",'last_mutation',NEW."last_mutation",'storage_version',NEW."storage_version"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.owner;
END;

CREATE TRIGGER r1_log_hris_workspaces_update AFTER UPDATE ON hris_workspaces
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.owner)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_workspaces',json_object('owner',NEW."owner"),'update',json_object('owner',NEW."owner",'revision',NEW."revision",'data',NEW."data",'last_mutation',NEW."last_mutation",'storage_version',NEW."storage_version"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.owner;
END;

CREATE TRIGGER r1_log_hris_workspaces_delete AFTER DELETE ON hris_workspaces
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.owner)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_workspaces',json_object('owner',OLD."owner"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.owner;
END;

CREATE TRIGGER r1_log_hris_audit_events_insert AFTER INSERT ON hris_audit_events
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_audit_events',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'actor_id',NEW."actor_id",'action',NEW."action",'subject',NEW."subject",'at',NEW."at",'revision',NEW."revision"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_audit_events_update AFTER UPDATE ON hris_audit_events
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_audit_events',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'actor_id',NEW."actor_id",'action',NEW."action",'subject',NEW."subject",'at',NEW."at",'revision',NEW."revision"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_audit_events_delete AFTER DELETE ON hris_audit_events
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_audit_events',json_object('tenant_id',OLD."tenant_id",'id',OLD."id"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_memberships_insert AFTER INSERT ON hris_memberships
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_memberships',json_object('user_id',NEW."user_id"),'insert',json_object('user_id',NEW."user_id",'tenant_id',NEW."tenant_id",'role',NEW."role",'employee_id',NEW."employee_id",'active',NEW."active",'org_scope',NEW."org_scope",'view_email',NEW."view_email",'view_level',NEW."view_level"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_memberships_update AFTER UPDATE ON hris_memberships
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_memberships',json_object('user_id',NEW."user_id"),'update',json_object('user_id',NEW."user_id",'tenant_id',NEW."tenant_id",'role',NEW."role",'employee_id',NEW."employee_id",'active',NEW."active",'org_scope',NEW."org_scope",'view_email',NEW."view_email",'view_level',NEW."view_level"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_memberships_delete AFTER DELETE ON hris_memberships
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_memberships',json_object('user_id',OLD."user_id"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_access_grants_insert AFTER INSERT ON hris_access_grants
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_access_grants',json_object('email',NEW."email"),'insert',json_object('email',NEW."email",'tenant_id',NEW."tenant_id",'name',NEW."name",'role',NEW."role",'employee_id',NEW."employee_id",'active',NEW."active",'claimed_by',NEW."claimed_by",'updated_at',NEW."updated_at",'org_scope',NEW."org_scope",'view_email',NEW."view_email",'view_level',NEW."view_level"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_access_grants_update AFTER UPDATE ON hris_access_grants
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_access_grants',json_object('email',NEW."email"),'update',json_object('email',NEW."email",'tenant_id',NEW."tenant_id",'name',NEW."name",'role',NEW."role",'employee_id',NEW."employee_id",'active',NEW."active",'claimed_by',NEW."claimed_by",'updated_at',NEW."updated_at",'org_scope',NEW."org_scope",'view_email',NEW."view_email",'view_level',NEW."view_level"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_access_grants_delete AFTER DELETE ON hris_access_grants
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_access_grants',json_object('email',OLD."email"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_installation_insert AFTER INSERT ON hris_installation
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_installation',json_object('id',NEW."id"),'insert',json_object('id',NEW."id",'tenant_id',NEW."tenant_id",'owner_id',NEW."owner_id",'name',NEW."name",'created_at',NEW."created_at"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_installation_update AFTER UPDATE ON hris_installation
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_installation',json_object('id',NEW."id"),'update',json_object('id',NEW."id",'tenant_id',NEW."tenant_id",'owner_id',NEW."owner_id",'name',NEW."name",'created_at',NEW."created_at"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_installation_delete AFTER DELETE ON hris_installation
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_installation',json_object('id',OLD."id"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_approval_steps_insert AFTER INSERT ON hris_approval_steps
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_approval_steps',json_object('tenant_id',NEW."tenant_id",'approval_id',NEW."approval_id",'position',NEW."position"),'insert',json_object('tenant_id',NEW."tenant_id",'approval_id',NEW."approval_id",'position',NEW."position",'user_id',NEW."user_id",'name',NEW."name",'decision',NEW."decision",'at',NEW."at"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_approval_steps_update AFTER UPDATE ON hris_approval_steps
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_approval_steps',json_object('tenant_id',NEW."tenant_id",'approval_id',NEW."approval_id",'position',NEW."position"),'update',json_object('tenant_id',NEW."tenant_id",'approval_id',NEW."approval_id",'position',NEW."position",'user_id',NEW."user_id",'name',NEW."name",'decision',NEW."decision",'at',NEW."at"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_approval_steps_delete AFTER DELETE ON hris_approval_steps
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_approval_steps',json_object('tenant_id',OLD."tenant_id",'approval_id',OLD."approval_id",'position',OLD."position"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_approvals_insert AFTER INSERT ON hris_approvals
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_approvals',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'employee_id',NEW."employee_id",'kind',NEW."kind",'org_id',NEW."org_id",'reason',NEW."reason",'status',NEW."status",'created',NEW."created",'created_by',NEW."created_by",'decided',NEW."decided",'decided_by',NEW."decided_by",'current_step',NEW."current_step",'workflow_version',NEW."workflow_version",'details',NEW."details"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_approvals_update AFTER UPDATE ON hris_approvals
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_approvals',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'employee_id',NEW."employee_id",'kind',NEW."kind",'org_id',NEW."org_id",'reason',NEW."reason",'status',NEW."status",'created',NEW."created",'created_by',NEW."created_by",'decided',NEW."decided",'decided_by',NEW."decided_by",'current_step',NEW."current_step",'workflow_version',NEW."workflow_version",'details',NEW."details"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_approvals_delete AFTER DELETE ON hris_approvals
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_approvals',json_object('tenant_id',OLD."tenant_id",'id',OLD."id"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_employees_insert AFTER INSERT ON hris_employees
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_employees',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'code',NEW."code",'name',NEW."name",'org_id',NEW."org_id",'job',NEW."job",'level',NEW."level",'joined',NEW."joined",'status',NEW."status",'email',NEW."email"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_employees_update AFTER UPDATE ON hris_employees
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_employees',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'code',NEW."code",'name',NEW."name",'org_id',NEW."org_id",'job',NEW."job",'level',NEW."level",'joined',NEW."joined",'status',NEW."status",'email',NEW."email"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_employees_delete AFTER DELETE ON hris_employees
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_employees',json_object('tenant_id',OLD."tenant_id",'id',OLD."id"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_employment_history_insert AFTER INSERT ON hris_employment_history
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_employment_history',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'employee_id',NEW."employee_id",'event_id',NEW."event_id",'at',NEW."at",'actor_id',NEW."actor_id",'from_org_id',NEW."from_org_id",'to_org_id',NEW."to_org_id",'from_status',NEW."from_status",'to_status',NEW."to_status",'job',NEW."job",'level',NEW."level"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_employment_history_update AFTER UPDATE ON hris_employment_history
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_employment_history',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'employee_id',NEW."employee_id",'event_id',NEW."event_id",'at',NEW."at",'actor_id',NEW."actor_id",'from_org_id',NEW."from_org_id",'to_org_id',NEW."to_org_id",'from_status',NEW."from_status",'to_status',NEW."to_status",'job',NEW."job",'level',NEW."level"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_employment_history_delete AFTER DELETE ON hris_employment_history
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_employment_history',json_object('tenant_id',OLD."tenant_id",'id',OLD."id"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_orgs_insert AFTER INSERT ON hris_orgs
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_orgs',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'name',NEW."name",'parent_id',NEW."parent_id",'city',NEW."city",'leader',NEW."leader",'status',NEW."status"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_orgs_update AFTER UPDATE ON hris_orgs
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_orgs',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'name',NEW."name",'parent_id',NEW."parent_id",'city',NEW."city",'leader',NEW."leader",'status',NEW."status"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_orgs_delete AFTER DELETE ON hris_orgs
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_orgs',json_object('tenant_id',OLD."tenant_id",'id',OLD."id"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_workflow_steps_insert AFTER INSERT ON hris_workflow_steps
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_workflow_steps',json_object('tenant_id',NEW."tenant_id",'kind',NEW."kind",'version',NEW."version",'position',NEW."position"),'insert',json_object('tenant_id',NEW."tenant_id",'kind',NEW."kind",'version',NEW."version",'position',NEW."position",'user_id',NEW."user_id",'name',NEW."name"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_workflow_steps_update AFTER UPDATE ON hris_workflow_steps
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_workflow_steps',json_object('tenant_id',NEW."tenant_id",'kind',NEW."kind",'version',NEW."version",'position',NEW."position"),'update',json_object('tenant_id',NEW."tenant_id",'kind',NEW."kind",'version',NEW."version",'position',NEW."position",'user_id',NEW."user_id",'name',NEW."name"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_workflow_steps_delete AFTER DELETE ON hris_workflow_steps
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_workflow_steps',json_object('tenant_id',OLD."tenant_id",'kind',OLD."kind",'version',OLD."version",'position',OLD."position"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_workflows_insert AFTER INSERT ON hris_workflows
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_workflows',json_object('tenant_id',NEW."tenant_id",'kind',NEW."kind",'version',NEW."version"),'insert',json_object('tenant_id',NEW."tenant_id",'kind',NEW."kind",'version',NEW."version"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_workflows_update AFTER UPDATE ON hris_workflows
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_workflows',json_object('tenant_id',NEW."tenant_id",'kind',NEW."kind",'version',NEW."version"),'update',json_object('tenant_id',NEW."tenant_id",'kind',NEW."kind",'version',NEW."version"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_workflows_delete AFTER DELETE ON hris_workflows
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_workflows',json_object('tenant_id',OLD."tenant_id",'kind',OLD."kind",'version',OLD."version"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_assignment_requests_insert AFTER INSERT ON hris_assignment_requests
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_assignment_requests',json_object('tenant_id',NEW."tenant_id",'approval_id',NEW."approval_id"),'insert',json_object('tenant_id',NEW."tenant_id",'approval_id',NEW."approval_id",'position_id',NEW."position_id",'grade_id',NEW."grade_id"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_assignment_requests_update AFTER UPDATE ON hris_assignment_requests
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_assignment_requests',json_object('tenant_id',NEW."tenant_id",'approval_id',NEW."approval_id"),'update',json_object('tenant_id',NEW."tenant_id",'approval_id',NEW."approval_id",'position_id',NEW."position_id",'grade_id',NEW."grade_id"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_assignment_requests_delete AFTER DELETE ON hris_assignment_requests
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_assignment_requests',json_object('tenant_id',OLD."tenant_id",'approval_id',OLD."approval_id"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_employee_positions_insert AFTER INSERT ON hris_employee_positions
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_employee_positions',json_object('tenant_id',NEW."tenant_id",'employee_id',NEW."employee_id"),'insert',json_object('tenant_id',NEW."tenant_id",'employee_id',NEW."employee_id",'position_id',NEW."position_id",'grade_id',NEW."grade_id"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_employee_positions_update AFTER UPDATE ON hris_employee_positions
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_employee_positions',json_object('tenant_id',NEW."tenant_id",'employee_id',NEW."employee_id"),'update',json_object('tenant_id',NEW."tenant_id",'employee_id',NEW."employee_id",'position_id',NEW."position_id",'grade_id',NEW."grade_id"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_employee_positions_delete AFTER DELETE ON hris_employee_positions
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_employee_positions',json_object('tenant_id',OLD."tenant_id",'employee_id',OLD."employee_id"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_grades_insert AFTER INSERT ON hris_grades
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_grades',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'code',NEW."code",'name',NEW."name",'sequence',NEW."sequence",'status',NEW."status"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_grades_update AFTER UPDATE ON hris_grades
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_grades',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'code',NEW."code",'name',NEW."name",'sequence',NEW."sequence",'status',NEW."status"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_grades_delete AFTER DELETE ON hris_grades
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_grades',json_object('tenant_id',OLD."tenant_id",'id',OLD."id"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_positions_insert AFTER INSERT ON hris_positions
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_positions',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'code',NEW."code",'name',NEW."name",'org_id',NEW."org_id",'family',NEW."family",'responsibilities',NEW."responsibilities",'status',NEW."status"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_positions_update AFTER UPDATE ON hris_positions
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_positions',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'code',NEW."code",'name',NEW."name",'org_id',NEW."org_id",'family',NEW."family",'responsibilities',NEW."responsibilities",'status',NEW."status"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_positions_delete AFTER DELETE ON hris_positions
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_positions',json_object('tenant_id',OLD."tenant_id",'id',OLD."id"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_attachments_insert AFTER INSERT ON hris_attachments
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_attachments',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'employee_id',NEW."employee_id",'record_id',NEW."record_id",'object_key',NEW."object_key",'name',NEW."name",'mime',NEW."mime",'size',NEW."size",'created_by',NEW."created_by",'created_at',NEW."created_at",'deleted_at',NEW."deleted_at",'visibility',NEW."visibility"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_attachments_update AFTER UPDATE ON hris_attachments
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_attachments',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'employee_id',NEW."employee_id",'record_id',NEW."record_id",'object_key',NEW."object_key",'name',NEW."name",'mime',NEW."mime",'size',NEW."size",'created_by',NEW."created_by",'created_at',NEW."created_at",'deleted_at',NEW."deleted_at",'visibility',NEW."visibility"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_attachments_delete AFTER DELETE ON hris_attachments
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_attachments',json_object('tenant_id',OLD."tenant_id",'id',OLD."id"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_development_records_insert AFTER INSERT ON hris_development_records
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_development_records',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'kind',NEW."kind",'employee_id',NEW."employee_id",'position_id',NEW."position_id",'reference_id',NEW."reference_id",'status',NEW."status",'payload',NEW."payload",'created_by',NEW."created_by",'created_at',NEW."created_at",'updated_at',NEW."updated_at"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_development_records_update AFTER UPDATE ON hris_development_records
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_development_records',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'kind',NEW."kind",'employee_id',NEW."employee_id",'position_id',NEW."position_id",'reference_id',NEW."reference_id",'status',NEW."status",'payload',NEW."payload",'created_by',NEW."created_by",'created_at',NEW."created_at",'updated_at',NEW."updated_at"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_development_records_delete AFTER DELETE ON hris_development_records
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_development_records',json_object('tenant_id',OLD."tenant_id",'id',OLD."id"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_log_hris_development_events_insert AFTER INSERT ON hris_development_events
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_development_events',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'insert',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'record_id',NEW."record_id",'revision',NEW."revision",'action',NEW."action",'actor_id',NEW."actor_id",'at',NEW."at",'snapshot',NEW."snapshot"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_development_events_update AFTER UPDATE ON hris_development_events
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_development_events',json_object('tenant_id',NEW."tenant_id",'id',NEW."id"),'update',json_object('tenant_id',NEW."tenant_id",'id',NEW."id",'record_id',NEW."record_id",'revision',NEW."revision",'action',NEW."action",'actor_id',NEW."actor_id",'at',NEW."at",'snapshot',NEW."snapshot"),s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=NEW.tenant_id;
END;

CREATE TRIGGER r1_log_hris_development_events_delete AFTER DELETE ON hris_development_events
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 INSERT INTO r1_recovery_changes(tenant_id,tx_id,table_name,row_key,operation,after_image,schema_version,workspace_revision)
 SELECT w.owner,w.last_mutation,'hris_development_events',json_object('tenant_id',OLD."tenant_id",'id',OLD."id"),'delete',NULL,s.schema_version,w.revision
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner WHERE w.owner=OLD.tenant_id;
END;

CREATE TRIGGER r1_auth_hris_memberships_insert AFTER INSERT ON hris_memberships
BEGIN UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=NEW.tenant_id; END;

CREATE TRIGGER r1_auth_hris_memberships_update AFTER UPDATE ON hris_memberships
BEGIN UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=NEW.tenant_id; END;

CREATE TRIGGER r1_auth_hris_memberships_delete AFTER DELETE ON hris_memberships
BEGIN UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=OLD.tenant_id; END;

CREATE TRIGGER r1_auth_hris_access_grants_insert AFTER INSERT ON hris_access_grants
BEGIN UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=NEW.tenant_id; END;

CREATE TRIGGER r1_auth_hris_access_grants_update AFTER UPDATE ON hris_access_grants
BEGIN UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=NEW.tenant_id; END;

CREATE TRIGGER r1_auth_hris_access_grants_delete AFTER DELETE ON hris_access_grants
BEGIN UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=OLD.tenant_id; END;

CREATE TRIGGER r1_auth_r1_permission_grants_insert AFTER INSERT ON r1_permission_grants
BEGIN UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=NEW.tenant_id; END;

CREATE TRIGGER r1_auth_r1_permission_grants_update AFTER UPDATE ON r1_permission_grants
BEGIN UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=NEW.tenant_id; END;

CREATE TRIGGER r1_auth_r1_permission_grants_delete AFTER DELETE ON r1_permission_grants
BEGIN UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=OLD.tenant_id; END;

CREATE TRIGGER r1_auth_r1_relationships_insert AFTER INSERT ON r1_relationships
BEGIN UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=NEW.tenant_id; END;

CREATE TRIGGER r1_auth_r1_relationships_update AFTER UPDATE ON r1_relationships
BEGIN UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=NEW.tenant_id; END;

CREATE TRIGGER r1_auth_r1_relationships_delete AFTER DELETE ON r1_relationships
BEGIN UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=OLD.tenant_id; END;

CREATE TRIGGER r1_guard_hris_audit_events_insert BEFORE INSERT ON hris_audit_events
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_audit_events_update BEFORE UPDATE ON hris_audit_events
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_audit_events_delete BEFORE DELETE ON hris_audit_events
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_memberships_insert BEFORE INSERT ON hris_memberships
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_memberships_update BEFORE UPDATE ON hris_memberships
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_memberships_delete BEFORE DELETE ON hris_memberships
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_access_grants_insert BEFORE INSERT ON hris_access_grants
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_access_grants_update BEFORE UPDATE ON hris_access_grants
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_access_grants_delete BEFORE DELETE ON hris_access_grants
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_installation_insert BEFORE INSERT ON hris_installation
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_installation_update BEFORE UPDATE ON hris_installation
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_installation_delete BEFORE DELETE ON hris_installation
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_approval_steps_insert BEFORE INSERT ON hris_approval_steps
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_approval_steps_update BEFORE UPDATE ON hris_approval_steps
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_approval_steps_delete BEFORE DELETE ON hris_approval_steps
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_approvals_insert BEFORE INSERT ON hris_approvals
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_approvals_update BEFORE UPDATE ON hris_approvals
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_approvals_delete BEFORE DELETE ON hris_approvals
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_employees_insert BEFORE INSERT ON hris_employees
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_employees_update BEFORE UPDATE ON hris_employees
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_employees_delete BEFORE DELETE ON hris_employees
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_employment_history_insert BEFORE INSERT ON hris_employment_history
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_employment_history_update BEFORE UPDATE ON hris_employment_history
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_employment_history_delete BEFORE DELETE ON hris_employment_history
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_orgs_insert BEFORE INSERT ON hris_orgs
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_orgs_update BEFORE UPDATE ON hris_orgs
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_orgs_delete BEFORE DELETE ON hris_orgs
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_workflow_steps_insert BEFORE INSERT ON hris_workflow_steps
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_workflow_steps_update BEFORE UPDATE ON hris_workflow_steps
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_workflow_steps_delete BEFORE DELETE ON hris_workflow_steps
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_workflows_insert BEFORE INSERT ON hris_workflows
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_workflows_update BEFORE UPDATE ON hris_workflows
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_workflows_delete BEFORE DELETE ON hris_workflows
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_assignment_requests_insert BEFORE INSERT ON hris_assignment_requests
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_assignment_requests_update BEFORE UPDATE ON hris_assignment_requests
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_assignment_requests_delete BEFORE DELETE ON hris_assignment_requests
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_employee_positions_insert BEFORE INSERT ON hris_employee_positions
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_employee_positions_update BEFORE UPDATE ON hris_employee_positions
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_employee_positions_delete BEFORE DELETE ON hris_employee_positions
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_grades_insert BEFORE INSERT ON hris_grades
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_grades_update BEFORE UPDATE ON hris_grades
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_grades_delete BEFORE DELETE ON hris_grades
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_positions_insert BEFORE INSERT ON hris_positions
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_positions_update BEFORE UPDATE ON hris_positions
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_positions_delete BEFORE DELETE ON hris_positions
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_attachments_insert BEFORE INSERT ON hris_attachments
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_attachments_update BEFORE UPDATE ON hris_attachments
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_attachments_delete BEFORE DELETE ON hris_attachments
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_development_records_insert BEFORE INSERT ON hris_development_records
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_development_records_update BEFORE UPDATE ON hris_development_records
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_development_records_delete BEFORE DELETE ON hris_development_records
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_development_events_insert BEFORE INSERT ON hris_development_events
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_development_events_update BEFORE UPDATE ON hris_development_events
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=NEW.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=NEW.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;

CREATE TRIGGER r1_guard_hris_development_events_delete BEFORE DELETE ON hris_development_events
WHEN EXISTS(SELECT 1 FROM r1_schema_state WHERE tenant_id=OLD.tenant_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_commands c JOIN hris_workspaces w ON w.owner=c.tenant_id JOIN r1_schema_state s ON s.tenant_id=w.owner
 WHERE w.owner=OLD.tenant_id AND c.token=w.last_mutation AND c.status='processing' AND c.workspace_revision+1=w.revision AND c.writer_epoch=s.writer_epoch AND c.recovery_epoch=s.recovery_epoch AND s.open_gate=1)
 THEN RAISE(ABORT,'WRITER_NOT_FENCED') END;
END;
