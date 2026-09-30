CREATE TABLE r1_workflow_batches(tenant_id TEXT NOT NULL,id TEXT NOT NULL,actor_id TEXT NOT NULL,digest TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
CREATE TRIGGER r1_workflow_batches_immutable BEFORE UPDATE ON r1_workflow_batches BEGIN SELECT RAISE(ABORT,'IMMUTABLE_BATCH'); END;
CREATE TRIGGER r1_workflow_batch_items_immutable BEFORE UPDATE ON r1_workflow_batch_items BEGIN SELECT RAISE(ABORT,'IMMUTABLE_BATCH_RESULT'); END;
