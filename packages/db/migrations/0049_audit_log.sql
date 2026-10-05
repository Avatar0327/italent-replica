CREATE TABLE "audit_command_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"command_id" text NOT NULL,
	"outcome" text NOT NULL,
	"error_code" text NOT NULL,
	"reason" text,
	"method" text,
	"path" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_action" text,
	"source_page_type" text,
	"source_page" text,
	"terminal" text,
	"client_version" text,
	"ip" text,
	"trace_id" text,
	CONSTRAINT "audit_command_failures_outcome_valid" CHECK ("audit_command_failures"."outcome" IN ('business_failed', 'storage_unwritable', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "audit_operation_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"behavior" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text,
	"summary" text NOT NULL,
	"total_count" integer NOT NULL,
	"success_count" integer NOT NULL,
	"failure_count" integer NOT NULL,
	"result" text NOT NULL,
	"error_report" jsonb,
	"attachment" jsonb,
	"command_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_action" text,
	"source_page_type" text,
	"source_page" text,
	"terminal" text,
	"client_version" text,
	"ip" text,
	"trace_id" text,
	CONSTRAINT "audit_operation_logs_behavior_valid" CHECK ("audit_operation_logs"."behavior" IN ('batch_update', 'import', 'export', 'download', 'print', 'purge')),
	CONSTRAINT "audit_operation_logs_result_valid" CHECK ("audit_operation_logs"."result" IN ('succeeded', 'partial', 'failed')),
	CONSTRAINT "audit_operation_logs_counts_valid" CHECK ("audit_operation_logs"."success_count" >= 0 AND "audit_operation_logs"."failure_count" >= 0
        AND "audit_operation_logs"."total_count" = "audit_operation_logs"."success_count" + "audit_operation_logs"."failure_count")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "operation" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "changes" jsonb;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "source_action" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "source_page_type" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "source_page" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "terminal" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "client_version" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "trace_id" text;--> statement-breakpoint
ALTER TABLE "audit_command_failures" ADD CONSTRAINT "audit_command_failures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_command_failures" ADD CONSTRAINT "audit_command_failures_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_operation_logs" ADD CONSTRAINT "audit_operation_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_operation_logs" ADD CONSTRAINT "audit_operation_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_command_failures_tenant_occurred" ON "audit_command_failures" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_command_failures_tenant_command" ON "audit_command_failures" USING btree ("tenant_id","command_id");--> statement-breakpoint
CREATE INDEX "audit_operation_logs_tenant_occurred" ON "audit_operation_logs" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_object_type" ON "audit_events" USING btree ("tenant_id","object_type","occurred_at");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_operation_valid" CHECK ("audit_events"."operation" IN ('create', 'update', 'delete', 'other'));