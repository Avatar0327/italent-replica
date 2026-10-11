CREATE TABLE "succession_calc_run_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"object_id" uuid NOT NULL,
	"level_id" uuid,
	"row_no" integer,
	"code" text NOT NULL,
	CONSTRAINT "succession_calc_failures_code" CHECK ("succession_calc_run_failures"."code" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "succession_calc_run_objects" (
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"object_id" uuid NOT NULL,
	"expected_revision" integer,
	"outcome" text,
	"retryable" boolean DEFAULT false NOT NULL,
	"page_no" integer NOT NULL,
	CONSTRAINT "succession_calc_run_objects_tenant_id_run_id_object_type_object_id_pk" PRIMARY KEY("tenant_id","run_id","object_type","object_id"),
	CONSTRAINT "succession_calc_objects_type" CHECK ("succession_calc_run_objects"."object_type" IN ('org','position','employee')),
	CONSTRAINT "succession_calc_objects_outcome" CHECK ("succession_calc_run_objects"."outcome" IN ('written', 'unchanged', 'manual_kept', 'failed', 'revision_conflict')),
	CONSTRAINT "succession_calc_objects_revision" CHECK ("succession_calc_run_objects"."expected_revision" >= 0),
	CONSTRAINT "succession_calc_objects_page" CHECK ("succession_calc_run_objects"."page_no" >= 0),
	CONSTRAINT "succession_calc_objects_retry" CHECK (NOT "succession_calc_run_objects"."retryable" OR "succession_calc_run_objects"."outcome" = 'failed')
);
--> statement-breakpoint
CREATE TABLE "succession_calc_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"trigger" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"principal_user_id" uuid,
	"owner_user_id" uuid,
	"requested_by" uuid,
	"command_id" text NOT NULL,
	"business_date" date NOT NULL,
	"phase" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"block_reason" text,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"last_error_code" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "succession_calc_runs_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "succession_calc_runs_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "succession_calc_runs_kind" CHECK ("succession_calc_runs"."kind" IN ('position_risk', 'org_health', 'org_health_reset', 'org_stats', 'exit_sweep')),
	CONSTRAINT "succession_calc_runs_status" CHECK ("succession_calc_runs"."status" IN ('pending', 'running', 'succeeded', 'partial', 'blocked', 'aborted')),
	CONSTRAINT "succession_calc_runs_trigger" CHECK ("succession_calc_runs"."trigger" IN ('schedule','manual','review_sync','preferences_change','retry')),
	CONSTRAINT "succession_calc_runs_counters" CHECK ("succession_calc_runs"."phase" >= 0 AND "succession_calc_runs"."attempt_no" > 0 AND "succession_calc_runs"."revision" > 0),
	CONSTRAINT "succession_calc_runs_owner" CHECK ("succession_calc_runs"."owner_user_id" IS NOT DISTINCT FROM "succession_calc_runs"."principal_user_id")
);
--> statement-breakpoint
CREATE TABLE "succession_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid,
	"batch_id" uuid,
	"subject_id" uuid GENERATED ALWAYS AS (COALESCE(run_id, batch_id)) STORED NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text DEFAULT 'in_app' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_no" integer DEFAULT 0 NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "succession_notifications_dedupe" UNIQUE("tenant_id","subject_id","recipient_user_id","kind"),
	CONSTRAINT "succession_notifications_subject" CHECK (num_nonnulls("succession_notifications"."run_id","succession_notifications"."batch_id") = 1),
	CONSTRAINT "succession_notifications_kind" CHECK (("succession_notifications"."kind"='calc_done' AND "succession_notifications"."run_id" IS NOT NULL)
    OR ("succession_notifications"."kind"='sync_done' AND "succession_notifications"."batch_id" IS NOT NULL)),
	CONSTRAINT "succession_notifications_state" CHECK ("succession_notifications"."state" IN ('pending','sent','failed','unknown')),
	CONSTRAINT "succession_notifications_attempt" CHECK ("succession_notifications"."attempt_no" >= 0)
);
--> statement-breakpoint
ALTER TABLE "succession_calc_run_failures" ADD CONSTRAINT "succession_calc_run_failures_tenant_id_run_id_object_type_object_id_succession_calc_run_objects_tenant_id_run_id_object_type_object_id_fk" FOREIGN KEY ("tenant_id","run_id","object_type","object_id") REFERENCES "public"."succession_calc_run_objects"("tenant_id","run_id","object_type","object_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_calc_run_objects" ADD CONSTRAINT "succession_calc_run_objects_tenant_id_run_id_succession_calc_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."succession_calc_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_calc_runs" ADD CONSTRAINT "succession_calc_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_calc_runs" ADD CONSTRAINT "succession_calc_runs_tenant_id_principal_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","principal_user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_calc_runs" ADD CONSTRAINT "succession_calc_runs_tenant_id_owner_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_calc_runs" ADD CONSTRAINT "succession_calc_runs_tenant_id_requested_by_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_notifications" ADD CONSTRAINT "succession_notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_notifications" ADD CONSTRAINT "succession_notifications_tenant_id_recipient_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","recipient_user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_notifications" ADD CONSTRAINT "succession_notifications_tenant_id_run_id_succession_calc_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."succession_calc_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "succession_notifications_pending" ON "succession_notifications" USING btree ("tenant_id","state","created_at","id");--> statement-breakpoint
-- B3a：通知行本身是持久化 outbox；四表全部走租户 RLS。
SELECT enable_tenant_isolation('succession_calc_runs');
--> statement-breakpoint
SELECT enable_tenant_isolation('succession_calc_run_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('succession_calc_run_failures');
--> statement-breakpoint
SELECT enable_tenant_isolation('succession_notifications');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON succession_calc_runs, succession_calc_run_objects, succession_notifications TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON succession_calc_run_failures TO app_user;
--> statement-breakpoint
-- users 属于平台域；只暴露本租户成员是否仍有效，不给租户角色读取全局 users 的权限。
CREATE FUNCTION succession_calc_user_active(t uuid, u uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t = nullif(current_setting('app.tenant_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM public.tenant_memberships m JOIN public.users u1 ON u1.id = m.user_id
    WHERE m.tenant_id = t AND m.user_id = u AND m.status = 'active' AND u1.status = 'active'
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION succession_calc_user_active(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION succession_calc_user_active(uuid, uuid) TO app_user;
