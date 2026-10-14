CREATE TABLE "succession_health_results" (
	"tenant_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"level_id" uuid,
	"method" text NOT NULL,
	"run_id" uuid,
	"source_batch_id" uuid,
	"source_project_id" uuid,
	"source_meeting_id" uuid,
	"computed_at" timestamp with time zone,
	"assigned_by" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "succession_health_results_tenant_id_org_id_pk" PRIMARY KEY("tenant_id","org_id"),
	CONSTRAINT "succession_health_method" CHECK ("succession_health_results"."method" IN ('computed','manual','synced')),
	CONSTRAINT "succession_health_revision" CHECK ("succession_health_results"."revision">0)
);
--> statement-breakpoint
ALTER TABLE "succession_target_locks" DROP CONSTRAINT "succession_target_locks_kind";--> statement-breakpoint
ALTER TABLE "succession_health_results" ADD CONSTRAINT "succession_health_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_health_results" ADD CONSTRAINT "succession_health_results_tenant_id_org_id_org_objects_tenant_id_id_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_health_results" ADD CONSTRAINT "succession_health_results_tenant_id_level_id_succession_health_levels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."succession_health_levels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_health_results" ADD CONSTRAINT "succession_health_results_tenant_id_run_id_succession_calc_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."succession_calc_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_health_results" ADD CONSTRAINT "succession_health_results_tenant_id_assigned_by_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","assigned_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_target_locks" ADD CONSTRAINT "succession_target_locks_kind" CHECK ("succession_target_locks"."target_kind" IN ('org','position','org_health'));