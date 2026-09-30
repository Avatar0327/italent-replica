-- Immutable occupancy facts share the exact command transaction with assignment history.
CREATE TABLE r1_occupancy_events (
 tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, assignment_id TEXT NOT NULL,
 person_id TEXT NOT NULL, position_id TEXT, delta INTEGER NOT NULL CHECK(delta IN (-1,0,1)),
 effective_at TEXT NOT NULL, command_id TEXT NOT NULL,
 PRIMARY KEY(tenant_id,event_id), UNIQUE(tenant_id,command_id,assignment_id)
);
CREATE INDEX r1_occupancy_position ON r1_occupancy_events(tenant_id,position_id,effective_at,event_id);
CREATE TRIGGER r1_occupancy_no_update BEFORE UPDATE ON r1_occupancy_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
CREATE TRIGGER r1_occupancy_no_delete BEFORE DELETE ON r1_occupancy_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
