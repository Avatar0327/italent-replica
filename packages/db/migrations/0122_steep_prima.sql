CREATE TABLE "succession_risk_results" (
	"tenant_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"level_id" uuid,
	"method" text NOT NULL,
	"run_id" uuid,
	"computed_at" timestamp with time zone,
	"assigned_by" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "succession_risk_results_tenant_id_position_id_pk" PRIMARY KEY("tenant_id","position_id"),
	CONSTRAINT "succession_risk_results_method" CHECK ("succession_risk_results"."method" IN ('manual','computed')),
	CONSTRAINT "succession_risk_results_revision" CHECK ("succession_risk_results"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "succession_risk_results" ADD CONSTRAINT "succession_risk_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_risk_results" ADD CONSTRAINT "succession_risk_results_tenant_id_position_id_job_position_objects_tenant_id_id_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_risk_results" ADD CONSTRAINT "succession_risk_results_tenant_id_level_id_succession_risk_levels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."succession_risk_levels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_risk_results" ADD CONSTRAINT "succession_risk_results_tenant_id_run_id_succession_calc_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."succession_calc_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_risk_results" ADD CONSTRAINT "succession_risk_results_tenant_id_assigned_by_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","assigned_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;