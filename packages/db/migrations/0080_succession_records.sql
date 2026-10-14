CREATE TABLE "succession_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"succession_type" text NOT NULL,
	"target_org_id" uuid,
	"target_position_id" uuid,
	"successor_employee_id" uuid NOT NULL,
	"readiness_id" uuid,
	"backup_type" text DEFAULT 'principal' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date DEFAULT '9999-12-31' NOT NULL,
	"end_reason" text,
	"end_source" text,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"exit_record_id" uuid,
	"source_kind" text DEFAULT 'manual' NOT NULL,
	"source_batch_id" uuid,
	"source_item_id" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "succession_records_type" CHECK ("succession_records"."succession_type" IN ('org', 'position')),
	CONSTRAINT "succession_records_target" CHECK (("succession_records"."succession_type" = 'org' AND "succession_records"."target_org_id" IS NOT NULL AND "succession_records"."target_position_id" IS NULL)
        OR ("succession_records"."succession_type" = 'position' AND "succession_records"."target_position_id" IS NOT NULL AND "succession_records"."target_org_id" IS NULL)),
	CONSTRAINT "succession_records_period" CHECK ("succession_records"."start_date" <= "succession_records"."end_date"),
	CONSTRAINT "succession_records_backup_type" CHECK ("succession_records"."backup_type" IN ('principal', 'deputy')),
	CONSTRAINT "succession_records_end_source" CHECK ("succession_records"."end_source" IS NULL OR "succession_records"."end_source" IN ('manual', 'exit', 'sync_overwrite', 'sync_scope_overwrite')),
	CONSTRAINT "succession_records_source_kind" CHECK ("succession_records"."source_kind" IN ('manual', 'review_sync')),
	CONSTRAINT "succession_records_revision" CHECK ("succession_records"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "succession_target_locks" (
	"tenant_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	CONSTRAINT "succession_target_locks_tenant_id_target_kind_target_id_pk" PRIMARY KEY("tenant_id","target_kind","target_id"),
	CONSTRAINT "succession_target_locks_kind" CHECK ("succession_target_locks"."target_kind" IN ('org', 'position'))
);
--> statement-breakpoint
ALTER TABLE "succession_records" ADD CONSTRAINT "succession_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_records" ADD CONSTRAINT "succession_records_successor_fk" FOREIGN KEY ("tenant_id","successor_employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_records" ADD CONSTRAINT "succession_records_target_org_fk" FOREIGN KEY ("tenant_id","target_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_records" ADD CONSTRAINT "succession_records_target_position_fk" FOREIGN KEY ("tenant_id","target_position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_records" ADD CONSTRAINT "succession_records_readiness_fk" FOREIGN KEY ("tenant_id","readiness_id") REFERENCES "public"."talent_readiness_levels"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_target_locks" ADD CONSTRAINT "succession_target_locks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "succession_records_org_target" ON "succession_records" USING btree ("tenant_id","succession_type","target_org_id","end_date");--> statement-breakpoint
CREATE INDEX "succession_records_position_target" ON "succession_records" USING btree ("tenant_id","succession_type","target_position_id","end_date");--> statement-breakpoint
CREATE INDEX "succession_records_successor" ON "succession_records" USING btree ("tenant_id","successor_employee_id","end_date");--> statement-breakpoint
CREATE INDEX "succession_records_exit" ON "succession_records" USING btree ("tenant_id","exit_record_id");