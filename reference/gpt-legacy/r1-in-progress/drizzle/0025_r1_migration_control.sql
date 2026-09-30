CREATE TABLE r1_migration_runs (
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,plan_version TEXT NOT NULL,source_sha TEXT NOT NULL,ddl_digest TEXT NOT NULL,
 phase TEXT NOT NULL,revision INTEGER NOT NULL,writer_epoch INTEGER NOT NULL,lease_owner TEXT NOT NULL,lease_until INTEGER NOT NULL,fencing_token INTEGER NOT NULL,
 source_table TEXT NOT NULL,cursor TEXT NOT NULL,rows_observed INTEGER NOT NULL,manifest_digest TEXT,reason_code TEXT,created_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id)
);
CREATE UNIQUE INDEX r1_migration_active_run ON r1_migration_runs(tenant_id) WHERE phase NOT IN ('monitored','rolled_back','failed');
CREATE TABLE r1_migration_map (
 tenant_id TEXT NOT NULL,source_table TEXT NOT NULL,source_key TEXT NOT NULL,mapping_version TEXT NOT NULL,ordinal INTEGER NOT NULL,
 source_revision INTEGER NOT NULL,source_digest TEXT NOT NULL,target_kind TEXT NOT NULL,target_id TEXT NOT NULL,confidence TEXT NOT NULL,issue_id TEXT,
 PRIMARY KEY(tenant_id,source_table,source_key,mapping_version,ordinal)
);
CREATE TABLE r1_migration_observations (
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,run_id TEXT NOT NULL,source_table TEXT NOT NULL,source_key TEXT NOT NULL,source_revision INTEGER NOT NULL,
 source_digest TEXT NOT NULL,source_image TEXT NOT NULL,recorded_at TEXT NOT NULL,history_quality TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,source_table,source_key,source_digest)
);
CREATE TRIGGER r1_migration_observations_immutable BEFORE UPDATE ON r1_migration_observations BEGIN SELECT RAISE(ABORT,'MIGRATION_OBSERVATION_IMMUTABLE'); END;
CREATE TABLE r1_migration_issues (
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,source_table TEXT NOT NULL,source_key TEXT NOT NULL,target_id TEXT,reason_code TEXT NOT NULL,
 status TEXT NOT NULL,revision INTEGER NOT NULL,evidence_ref TEXT,resolved_by TEXT,detail TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE r1_migration_batches (
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,run_id TEXT NOT NULL,source_table TEXT NOT NULL,cursor_digest TEXT NOT NULL,from_key TEXT NOT NULL,to_key TEXT NOT NULL,
 row_count INTEGER NOT NULL,input_digest TEXT NOT NULL,output_digest TEXT NOT NULL,fencing_token INTEGER NOT NULL,command_id TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,run_id,source_table,cursor_digest)
);
CREATE TABLE r1_migration_archives (
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,source_revision INTEGER NOT NULL,source_digest TEXT NOT NULL,source_json TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,source_digest)
);
CREATE TRIGGER r1_migration_archive_immutable BEFORE UPDATE ON r1_migration_archives BEGIN SELECT RAISE(ABORT,'MIGRATION_ARCHIVE_IMMUTABLE'); END;
CREATE TABLE r1_migration_reconciliation (
 tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,source_table TEXT NOT NULL,cursor TEXT NOT NULL,row_count INTEGER NOT NULL,digest TEXT NOT NULL,difference_count INTEGER NOT NULL,
 source_revision INTEGER NOT NULL,completed INTEGER NOT NULL,PRIMARY KEY(tenant_id,run_id,source_table)
);
CREATE TABLE r1_attachment_integrity (
 tenant_id TEXT NOT NULL,attachment_id TEXT NOT NULL,object_key TEXT NOT NULL,digest TEXT,byte_count INTEGER,status TEXT NOT NULL,reason_code TEXT,
 observed_at TEXT NOT NULL,source_digest TEXT NOT NULL,PRIMARY KEY(tenant_id,attachment_id)
);
