CREATE TABLE "ev_sync_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"handler" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"outbox_id" uuid,
	"employee_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ev_sync_queue_dedupe" UNIQUE("tenant_id","handler","dedupe_key"),
	CONSTRAINT "ev_sync_queue_state" CHECK ("ev_sync_queue"."state" IN ('pending', 'done', 'skipped', 'failed')),
	CONSTRAINT "ev_sync_queue_attempts" CHECK ("ev_sync_queue"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ev_sync_queue" ADD CONSTRAINT "ev_sync_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_sync_queue" ADD CONSTRAINT "ev_sync_queue_outbox_fk" FOREIGN KEY ("tenant_id","outbox_id") REFERENCES "public"."employment_outbox"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_sync_queue" ADD CONSTRAINT "ev_sync_queue_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ev_sync_queue_pickup" ON "ev_sync_queue" USING btree ("tenant_id","handler","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "ev_sync_queue_record" ON "ev_sync_queue" USING btree ("tenant_id","record_id");

--> statement-breakpoint
-- R3-T02 C1-4：统一租户隔离（AGENTS §2；guard-rls）。队列行不删，只推进状态；应用角色需要 SELECT / INSERT / UPDATE。
SELECT enable_tenant_isolation('ev_sync_queue');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON ev_sync_queue TO app_user;
--> statement-breakpoint
-- 入队触发器（设计 §4.3）：任职记录事件写入 employment_outbox 的同一事务里，为 qualification_sync 插一行 pending。
-- 事件与队列行同时提交或回滚，不论 created_at 与提交先后如何错位都不会漏；到期比较留给消费者按租户时区做
-- （触发器不知道租户时区，next_attempt_at 取事件创建时间，即“立即可取”，是否到生效日由 F-055 的 recordEventReadySql 判定）。
-- C2-1b 用 CREATE OR REPLACE 追加 evaluation_leave；重复入队 ON CONFLICT DO NOTHING，各处理器各占一行。
CREATE FUNCTION ev_enqueue_qualification_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ev_sync_queue (tenant_id, handler, dedupe_key, outbox_id, employee_id, record_id, next_attempt_at)
  VALUES (NEW.tenant_id, 'qualification_sync', NEW.id::text, NEW.id, NEW.employee_id, NEW.object_id, NEW.created_at)
  ON CONFLICT (tenant_id, handler, dedupe_key) DO NOTHING;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employment_outbox_enqueue_qualification_sync
AFTER INSERT ON employment_outbox
FOR EACH ROW
WHEN (NEW.event_type = 'employment.record.create' AND NEW.employee_id IS NOT NULL)
EXECUTE FUNCTION ev_enqueue_qualification_sync();
