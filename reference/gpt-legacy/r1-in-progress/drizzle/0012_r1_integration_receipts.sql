CREATE TABLE r1_inbox (
 tenant_id TEXT NOT NULL,source TEXT NOT NULL,event_id TEXT NOT NULL,sequence INTEGER NOT NULL,
 entity_id TEXT NOT NULL,digest TEXT NOT NULL,mapping_version INTEGER NOT NULL,
 received_at TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(tenant_id,source,event_id)
);
CREATE TABLE r1_source_cursors (
 tenant_id TEXT NOT NULL,source TEXT NOT NULL,entity_id TEXT NOT NULL,sequence INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,source,entity_id)
);
CREATE TABLE r1_integration_quarantine (
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,source TEXT NOT NULL,event_id TEXT NOT NULL,
 reason TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(tenant_id,id)
);
CREATE TABLE r1_deliveries (
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,
 recipient_id TEXT NOT NULL,state TEXT NOT NULL,receipt_id TEXT,receipt_digest TEXT,
 external_mode TEXT NOT NULL,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,source_id,source_revision,recipient_id)
);
CREATE TABLE r1_object_cleanup (
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,object_key TEXT NOT NULL,reason TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(tenant_id,id)
);
