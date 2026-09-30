CREATE TABLE r1_workflow_roots (tenant_id TEXT NOT NULL,id TEXT NOT NULL,business_type TEXT NOT NULL,current_version INTEGER NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,id));
CREATE TABLE r1_workflow_templates (tenant_id TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,published_at TEXT NOT NULL,PRIMARY KEY(tenant_id,id,version));
CREATE TABLE r1_workflow_instances (
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,business_type TEXT NOT NULL,business_id TEXT NOT NULL,application_version INTEGER NOT NULL,
 request_digest TEXT NOT NULL,org_id TEXT NOT NULL,person_id TEXT,title TEXT NOT NULL,initiator_id TEXT NOT NULL,
 revision INTEGER NOT NULL,generation INTEGER NOT NULL,approval_status TEXT NOT NULL,effect_status TEXT NOT NULL,
 current_node_id TEXT,source_revision INTEGER NOT NULL,template_payload TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,business_type,business_id,application_version)
);
CREATE INDEX r1_workflow_list ON r1_workflow_instances(tenant_id,approval_status,business_type,id);
CREATE INDEX r1_workflow_effects ON r1_workflow_instances(tenant_id,effect_status,id);
CREATE TABLE r1_workflow_nodes (tenant_id TEXT NOT NULL,id TEXT NOT NULL,instance_id TEXT NOT NULL,node_key TEXT NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL,status TEXT NOT NULL,assignees TEXT NOT NULL,policy TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
CREATE INDEX r1_workflow_node_instance ON r1_workflow_nodes(tenant_id,instance_id,generation,id);
CREATE TABLE r1_workflow_decisions (tenant_id TEXT NOT NULL,id TEXT NOT NULL,node_id TEXT NOT NULL,node_revision INTEGER NOT NULL,actor_id TEXT NOT NULL,decision TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL,command_id TEXT NOT NULL,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,node_id,node_revision,actor_id));
CREATE TABLE r1_workflow_events (tenant_id TEXT NOT NULL,id TEXT NOT NULL,instance_id TEXT,action TEXT NOT NULL,actor_id TEXT NOT NULL,principal_id TEXT,delegation_id TEXT,payload TEXT NOT NULL,at TEXT NOT NULL,command_id TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
CREATE TABLE r1_admin_delegations (tenant_id TEXT NOT NULL,id TEXT NOT NULL,principal_id TEXT NOT NULL,delegate_id TEXT NOT NULL,actions TEXT NOT NULL,business_types TEXT NOT NULL,scope TEXT NOT NULL,fields TEXT NOT NULL,start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,accepted_at TEXT,revision INTEGER NOT NULL,status TEXT NOT NULL,revoke_reason TEXT,PRIMARY KEY(tenant_id,id));
CREATE INDEX r1_delegation_lookup ON r1_admin_delegations(tenant_id,delegate_id,status,end_at,id);
CREATE TABLE r1_workflow_notifications (tenant_id TEXT NOT NULL,id TEXT NOT NULL,instance_id TEXT NOT NULL,node_id TEXT NOT NULL,node_revision INTEGER NOT NULL,recipient_id TEXT NOT NULL,template_version INTEGER NOT NULL,status TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,provider_receipt_id TEXT,digest TEXT NOT NULL,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,node_id,node_revision,recipient_id,template_version));
CREATE TABLE r1_workflow_batch_items (tenant_id TEXT NOT NULL,batch_id TEXT NOT NULL,item_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_digest TEXT NOT NULL,command_id TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(tenant_id,batch_id,item_id));
CREATE TABLE r1_workflow_commit_guard (tenant_id TEXT NOT NULL,command_id TEXT NOT NULL,valid INTEGER NOT NULL CONSTRAINT r1_delegation_commit_guard CHECK(valid=1),PRIMARY KEY(tenant_id,command_id));
CREATE TRIGGER r1_workflow_templates_no_update BEFORE UPDATE ON r1_workflow_templates BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TEMPLATE'); END;
CREATE TRIGGER r1_workflow_templates_no_delete BEFORE DELETE ON r1_workflow_templates BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TEMPLATE'); END;
CREATE TRIGGER r1_workflow_decisions_no_update BEFORE UPDATE ON r1_workflow_decisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DECISION'); END;
CREATE TRIGGER r1_workflow_decisions_no_delete BEFORE DELETE ON r1_workflow_decisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DECISION'); END;
CREATE TRIGGER r1_workflow_events_no_update BEFORE UPDATE ON r1_workflow_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVENT'); END;
CREATE TRIGGER r1_workflow_events_no_delete BEFORE DELETE ON r1_workflow_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVENT'); END;
CREATE TRIGGER r1_delegation_authority_insert AFTER INSERT ON r1_admin_delegations BEGIN UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=NEW.tenant_id; END;
CREATE TRIGGER r1_delegation_authority_update AFTER UPDATE ON r1_admin_delegations BEGIN UPDATE r1_schema_state SET authorization_revision=authorization_revision+1 WHERE tenant_id=NEW.tenant_id; END;
