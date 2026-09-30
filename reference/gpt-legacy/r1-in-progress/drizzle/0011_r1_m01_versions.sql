-- M01 stable objects and immutable versions. Activation remains controlled by r1_schema_state.
CREATE TABLE r1_m01_entities (
 tenant_id TEXT NOT NULL REFERENCES hris_workspaces(owner),id TEXT NOT NULL,kind TEXT NOT NULL,
 person_id TEXT,org_id TEXT,code TEXT,revision INTEGER NOT NULL,status TEXT NOT NULL,
 payload TEXT NOT NULL,PRIMARY KEY(tenant_id,id)
);
CREATE INDEX r1_m01_person_kind ON r1_m01_entities(tenant_id,person_id,kind,id);
CREATE INDEX r1_m01_kind_org ON r1_m01_entities(tenant_id,kind,org_id,id);
CREATE UNIQUE INDEX r1_m01_code ON r1_m01_entities(tenant_id,kind,code) WHERE code IS NOT NULL;
CREATE TABLE r1_m01_versions (
 tenant_id TEXT NOT NULL,entity_id TEXT NOT NULL,version INTEGER NOT NULL,
 workspace_revision INTEGER NOT NULL,command_id TEXT NOT NULL,recorded_at TEXT NOT NULL,
 valid_from TEXT,valid_to TEXT,history_quality TEXT NOT NULL,payload TEXT NOT NULL,
 PRIMARY KEY(tenant_id,entity_id,version),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES r1_m01_entities(tenant_id,id)
);
CREATE TABLE r1_exit_fences (
 tenant_id TEXT NOT NULL,person_id TEXT NOT NULL,effective_at TEXT NOT NULL,
 command_id TEXT NOT NULL,PRIMARY KEY(tenant_id,person_id)
);
CREATE TABLE r1_exit_cleanup (
 tenant_id TEXT NOT NULL,person_id TEXT NOT NULL,business_type TEXT NOT NULL,business_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued',reason TEXT,PRIMARY KEY(tenant_id,person_id,business_type,business_id)
);
CREATE TRIGGER r1_m01_versions_no_update BEFORE UPDATE ON r1_m01_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
CREATE TRIGGER r1_m01_versions_no_delete BEFORE DELETE ON r1_m01_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;

CREATE TABLE r1_import_receipts (
 tenant_id TEXT NOT NULL,batch_id TEXT NOT NULL,row_no INTEGER NOT NULL,attempt_version INTEGER NOT NULL,
 request_digest TEXT NOT NULL,entity_id TEXT NOT NULL,PRIMARY KEY(tenant_id,batch_id,row_no,attempt_version)
);
