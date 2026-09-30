CREATE TABLE r1_report_subscriptions (
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,owner_id TEXT NOT NULL,org_id TEXT NOT NULL,title TEXT NOT NULL,
 query_json TEXT NOT NULL,recipient_ids TEXT NOT NULL,timezone TEXT NOT NULL,frequency TEXT NOT NULL,week_days TEXT NOT NULL,local_send_time TEXT NOT NULL,
 gap_policy TEXT NOT NULL,repeat_policy TEXT NOT NULL,start_at TEXT NOT NULL,end_at TEXT NOT NULL,channel TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','blocked','expired')),revision INTEGER NOT NULL,proposed_owner TEXT,created_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE r1_report_subscription_events (
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,subscription_id TEXT NOT NULL,revision INTEGER NOT NULL,actor_id TEXT NOT NULL,operation TEXT NOT NULL,payload TEXT NOT NULL,at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id)
);
CREATE TRIGGER r1_subscription_history_immutable BEFORE UPDATE ON r1_report_subscription_events BEGIN SELECT RAISE(ABORT,'SUBSCRIPTION_HISTORY_IMMUTABLE'); END;
CREATE TABLE r1_report_subscription_results (
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,subscription_id TEXT NOT NULL,subscription_revision INTEGER NOT NULL,owner_id TEXT NOT NULL,recipient_id TEXT NOT NULL,
 occurrence_at TEXT NOT NULL,local_day TEXT NOT NULL,local_send_time TEXT NOT NULL,utc_offset_minutes INTEGER NOT NULL,channel TEXT NOT NULL,
 query_json TEXT NOT NULL,generation_id TEXT NOT NULL,manifest TEXT NOT NULL,manifest_digest TEXT NOT NULL,authorization_revision INTEGER NOT NULL,scope_revision INTEGER NOT NULL,
 delivery_state TEXT NOT NULL CHECK(delivery_state IN ('pending','unknown','sent','failed','suppressed')),attempt INTEGER NOT NULL DEFAULT 0,receipt_id TEXT,reason_code TEXT,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,subscription_id,subscription_revision,occurrence_at,recipient_id,channel),UNIQUE(tenant_id,subscription_id,subscription_revision,local_day,local_send_time,recipient_id,channel)
);
CREATE INDEX r1_subscription_delivery ON r1_report_subscription_results(tenant_id,delivery_state,occurrence_at,id);
