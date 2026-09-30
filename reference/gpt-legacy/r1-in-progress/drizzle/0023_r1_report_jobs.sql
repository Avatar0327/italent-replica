CREATE TABLE r1_report_jobs (
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,requester_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,
 dataset_id TEXT NOT NULL,generation_id TEXT NOT NULL,query TEXT NOT NULL,columns_json TEXT NOT NULL,
 definition_id TEXT,definition_version INTEGER,status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed','cancelled','expired')),
 runtime_state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,fencing_token INTEGER NOT NULL DEFAULT 0,
 next_cursor TEXT,sequence INTEGER NOT NULL DEFAULT 0,row_count INTEGER NOT NULL DEFAULT 0,byte_count INTEGER NOT NULL DEFAULT 0,attempt INTEGER NOT NULL DEFAULT 0,
 result_manifest TEXT,reason_code TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,authorization_revision INTEGER NOT NULL,scope_revision INTEGER NOT NULL,
 subscription_id TEXT,subscription_revision INTEGER,recipient_id TEXT,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,requester_id,idempotency_key)
);
CREATE INDEX r1_report_job_queue ON r1_report_jobs(tenant_id,status,lease_until,created_at);
CREATE TABLE r1_report_job_chunks (
 tenant_id TEXT NOT NULL,job_id TEXT NOT NULL,sequence INTEGER NOT NULL,object_key TEXT NOT NULL,digest TEXT NOT NULL,
 row_count INTEGER NOT NULL,byte_count INTEGER NOT NULL,first_key TEXT NOT NULL,last_key TEXT NOT NULL,fencing_token INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,job_id,sequence),UNIQUE(tenant_id,object_key)
);
CREATE TRIGGER r1_report_job_chunk_immutable BEFORE UPDATE ON r1_report_job_chunks BEGIN SELECT RAISE(ABORT,'REPORT_CHUNK_IMMUTABLE'); END;
CREATE TABLE r1_report_file_intents (
 tenant_id TEXT NOT NULL,object_key TEXT NOT NULL,job_id TEXT NOT NULL,fencing_token INTEGER NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('orphan','referenced','tombstone','deleted')),
 digest TEXT NOT NULL,byte_count INTEGER NOT NULL,PRIMARY KEY(tenant_id,object_key)
);
CREATE INDEX r1_report_file_gc ON r1_report_file_intents(tenant_id,status,created_at);
ALTER TABLE r1_schema_state ADD COLUMN report_scope_revision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER r1_report_person_scope_changed AFTER UPDATE OF org_id,status ON r1_m01_entities WHEN NEW.kind='person' AND (OLD.org_id IS NOT NEW.org_id OR OLD.status IS NOT NEW.status) BEGIN UPDATE r1_schema_state SET report_scope_revision=report_scope_revision+1 WHERE tenant_id=NEW.tenant_id; END;
CREATE TRIGGER r1_report_person_scope_deleted AFTER DELETE ON r1_m01_entities WHEN OLD.kind='person' BEGIN UPDATE r1_schema_state SET report_scope_revision=report_scope_revision+1 WHERE tenant_id=OLD.tenant_id; END;
CREATE TRIGGER r1_report_legacy_scope_changed AFTER UPDATE OF org_id,status ON hris_employees WHEN OLD.org_id IS NOT NEW.org_id OR OLD.status IS NOT NEW.status BEGIN UPDATE r1_schema_state SET report_scope_revision=report_scope_revision+1 WHERE tenant_id=NEW.tenant_id; END;
ALTER TABLE r1_report_jobs ADD COLUMN permission_valid_until INTEGER NOT NULL DEFAULT 9007199254740991;
