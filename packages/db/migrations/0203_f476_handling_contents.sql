ALTER TABLE "approval_instance_logs" ADD CONSTRAINT "approval_logs_tenant_id" UNIQUE("tenant_id","id");--> statement-breakpoint
CREATE TABLE "approval_handling_contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"handling_log_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"node_key" text NOT NULL,
	"activation_id" uuid,
	"process_version_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"handling_kind" text NOT NULL,
	"action" text NOT NULL,
	"business_type" text NOT NULL,
	"business_id" uuid NOT NULL,
	"business_version" text NOT NULL,
	"content_schema_version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"disclosure_ceiling" jsonb,
	"payload_bytes" integer NOT NULL,
	"content_digest" text NOT NULL,
	"acted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_handling_contents_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "approval_handling_contents_log" UNIQUE("tenant_id","handling_log_id"),
	CONSTRAINT "approval_handling_contents_kind" CHECK ("approval_handling_contents"."handling_kind" IN ('human','system')),
	CONSTRAINT "approval_handling_contents_round" CHECK ("approval_handling_contents"."round" > 0 AND "approval_handling_contents"."content_schema_version" > 0),
	CONSTRAINT "approval_handling_contents_size" CHECK ("approval_handling_contents"."payload_bytes" > 0 AND "approval_handling_contents"."payload_bytes" <= 16777216),
	CONSTRAINT "approval_handling_contents_human" CHECK ("approval_handling_contents"."handling_kind" <> 'human' OR "approval_handling_contents"."actor_user_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "approval_handling_contents" ADD CONSTRAINT "approval_handling_contents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_handling_contents" ADD CONSTRAINT "approval_handling_contents_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."approval_instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_handling_contents" ADD CONSTRAINT "approval_handling_contents_task_fk" FOREIGN KEY ("tenant_id","task_id") REFERENCES "public"."approval_tasks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_handling_contents" ADD CONSTRAINT "approval_handling_contents_log_fk" FOREIGN KEY ("tenant_id","handling_log_id") REFERENCES "public"."approval_instance_logs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_handling_contents" ADD CONSTRAINT "approval_handling_contents_version_fk" FOREIGN KEY ("tenant_id","process_version_id") REFERENCES "public"."approval_process_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_handling_contents_task" ON "approval_handling_contents" USING btree ("tenant_id","task_id");--> statement-breakpoint
CREATE INDEX "approval_handling_contents_actor" ON "approval_handling_contents" USING btree ("tenant_id","instance_id","actor_user_id","handling_log_id");--> statement-breakpoint
-- F-476（DEC-781）：办理份强制租户隔离，应用角色只有 SELECT / INSERT；只追加；插入时核对任务 / 日志 / 实例的一致性。
SELECT enable_tenant_isolation('approval_handling_contents');
--> statement-breakpoint
GRANT SELECT, INSERT ON "approval_handling_contents" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "approval_handling_contents_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "approval_handling_contents" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE FUNCTION approval_handling_contents_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  task_row approval_tasks%ROWTYPE;
  log_row approval_instance_logs%ROWTYPE;
  instance_row approval_instances%ROWTYPE;
BEGIN
  SELECT * INTO task_row FROM approval_tasks WHERE tenant_id = NEW.tenant_id AND id = NEW.task_id;
  SELECT * INTO log_row FROM approval_instance_logs WHERE tenant_id = NEW.tenant_id AND id = NEW.handling_log_id;
  SELECT * INTO instance_row FROM approval_instances WHERE tenant_id = NEW.tenant_id AND id = NEW.instance_id;
  -- 任务、办理日志、实例必须是同一次办理：轮次 / 节点取任务，业务与流程版本取实例，办理人取日志
  IF task_row.id IS NULL OR log_row.id IS NULL OR instance_row.id IS NULL
    OR task_row.instance_id <> NEW.instance_id OR task_row.round <> NEW.round OR task_row.node_key <> NEW.node_key
    OR log_row.instance_id <> NEW.instance_id OR log_row.round <> NEW.round
    OR log_row.actor_user_id IS DISTINCT FROM NEW.actor_user_id
    OR instance_row.business_type <> NEW.business_type OR instance_row.business_id <> NEW.business_id
    OR instance_row.version_id <> NEW.process_version_id THEN
    RAISE EXCEPTION 'approval_handling_contents 与任务 / 日志 / 实例不一致' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "approval_handling_contents_guard" BEFORE INSERT ON "approval_handling_contents"
  FOR EACH ROW EXECUTE FUNCTION approval_handling_contents_guard();
