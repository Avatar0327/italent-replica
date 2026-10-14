CREATE TABLE "succession_sync_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"meeting_id" uuid,
	"trigger" text NOT NULL,
	"manual_override" boolean DEFAULT false NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_scope_checked_at" timestamp with time zone,
	"source_principal_user_id" uuid NOT NULL,
	"write_principal_user_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"strategy" text,
	"scope_org_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope_explicit" boolean DEFAULT false NOT NULL,
	"business_date" date NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"has_plan" boolean DEFAULT false NOT NULL,
	"result" text,
	"block_reason" text,
	"end_reason" text,
	"execution_no" integer,
	"lease_owner" text,
	"next_page_no" integer DEFAULT 1 NOT NULL,
	"auto_retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"planned_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "succession_sync_batches_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "succession_sync_batches_run" UNIQUE("tenant_id","source_run_id"),
	CONSTRAINT "succession_sync_batches_status" CHECK ("succession_sync_batches"."status" IN ('waiting','executing','blocked','completed','terminated','rejected')),
	CONSTRAINT "succession_sync_batches_strategy" CHECK ("succession_sync_batches"."strategy" IN ('append','overwrite','overwrite_in_scope')),
	CONSTRAINT "succession_sync_batches_result" CHECK ("succession_sync_batches"."result" IN ('succeeded','partial')),
	CONSTRAINT "succession_sync_batches_revision" CHECK ("succession_sync_batches"."revision" > 0 AND "succession_sync_batches"."next_page_no" > 0
      AND "succession_sync_batches"."auto_retry_count" >= 0 AND ("succession_sync_batches"."execution_no" IS NULL OR "succession_sync_batches"."execution_no" >= 0))
);
--> statement-breakpoint
CREATE TABLE "succession_sync_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"nomination_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"subject_employee_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"direction" text NOT NULL,
	"target_org_id" uuid,
	"target_position_id" uuid,
	"successor_employee_id" uuid NOT NULL,
	"readiness_id" uuid,
	"plan_outcome" text NOT NULL,
	"exec_outcome" text,
	"record_id" uuid,
	"error_code" text,
	"error_params" jsonb,
	"retryable" boolean DEFAULT false NOT NULL,
	"execution_no" integer NOT NULL,
	"page_command_id" text NOT NULL,
	CONSTRAINT "succession_sync_items_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "succession_sync_items_nomination" UNIQUE("tenant_id","batch_id","nomination_id"),
	CONSTRAINT "succession_sync_items_kind" CHECK ("succession_sync_items"."kind" IN ('org','position')),
	CONSTRAINT "succession_sync_items_direction" CHECK ("succession_sync_items"."direction" IN ('successor','target')),
	CONSTRAINT "succession_sync_items_plan" CHECK ("succession_sync_items"."plan_outcome" IN ('planned','failed','skipped')),
	CONSTRAINT "succession_sync_items_exec" CHECK ("succession_sync_items"."exec_outcome" IN ('created','updated','exists','failed','aborted')),
	CONSTRAINT "succession_sync_items_target" CHECK (("succession_sync_items"."kind"='org' AND "succession_sync_items"."target_org_id" IS NOT NULL
      AND "succession_sync_items"."target_position_id" IS NULL) OR ("succession_sync_items"."kind"='position' AND "succession_sync_items"."target_position_id" IS NOT NULL
      AND "succession_sync_items"."target_org_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "succession_sync_mutex" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "succession_sync_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"action" text NOT NULL,
	"planned_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"old_record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"health_level_id" uuid,
	"health_manual" boolean,
	"health_status" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"retryable" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"error_params" jsonb,
	"ended_record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_row_key" text NOT NULL,
	"execution_no" integer NOT NULL,
	"page_command_id" text NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "succession_sync_targets_target" UNIQUE("tenant_id","batch_id","target_kind","target_id"),
	CONSTRAINT "succession_sync_targets_kind" CHECK ("succession_sync_targets"."target_kind" IN ('org','position','org_health')),
	CONSTRAINT "succession_sync_targets_action" CHECK ("succession_sync_targets"."action" IN ('append','overwrite','scope_overwrite','delete_only','health_write')),
	CONSTRAINT "succession_sync_targets_status" CHECK ("succession_sync_targets"."status" IN ('pending','done','failed','aborted')),
	CONSTRAINT "succession_sync_targets_health" CHECK ("succession_sync_targets"."health_status" IN ('value','empty','not_provided','forbidden')),
	CONSTRAINT "succession_sync_targets_health_action" CHECK (("succession_sync_targets"."target_kind"='org_health') = ("succession_sync_targets"."action"='health_write'))
);
--> statement-breakpoint
ALTER TABLE "succession_sync_batches" ADD CONSTRAINT "succession_sync_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_sync_items" ADD CONSTRAINT "succession_sync_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_sync_items" ADD CONSTRAINT "succession_sync_items_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."succession_sync_batches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_sync_mutex" ADD CONSTRAINT "succession_sync_mutex_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_sync_mutex" ADD CONSTRAINT "succession_sync_mutex_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."succession_sync_batches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_sync_targets" ADD CONSTRAINT "succession_sync_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_sync_targets" ADD CONSTRAINT "succession_sync_targets_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."succession_sync_batches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "succession_sync_batches_pending" ON "succession_sync_batches" USING btree ("tenant_id","status","next_retry_at");--> statement-breakpoint
CREATE INDEX "succession_sync_targets_barrier" ON "succession_sync_targets" USING btree ("tenant_id","target_kind","target_id","status");