CREATE TABLE r1_workflow_denials(tenant_id TEXT NOT NULL,id TEXT NOT NULL,actor_id TEXT NOT NULL,command_id TEXT NOT NULL,action TEXT NOT NULL,reason_code TEXT NOT NULL,authorization_revision INTEGER NOT NULL,at TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
CREATE TRIGGER r1_workflow_denials_immutable BEFORE UPDATE ON r1_workflow_denials BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DENIAL'); END;
ALTER TABLE r1_workflow_decisions ADD COLUMN digest TEXT;
ALTER TABLE r1_workflow_decisions ADD COLUMN actor_name TEXT;
