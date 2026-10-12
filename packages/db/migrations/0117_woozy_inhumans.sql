CREATE TABLE "succession_map_preferences" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"map_kind" text NOT NULL,
	"root_org_id" uuid,
	"depth" integer NOT NULL,
	"hidden_org_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hide_virtual" boolean DEFAULT false NOT NULL,
	"show_key_positions" boolean DEFAULT false NOT NULL,
	"show_positions_without_successor" boolean DEFAULT true NOT NULL,
	"show_incumbents" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "succession_map_preferences_tenant_id_user_id_map_kind_pk" PRIMARY KEY("tenant_id","user_id","map_kind"),
	CONSTRAINT "succession_preferences_kind" CHECK ("succession_map_preferences"."map_kind" IN ('org','position')),
	CONSTRAINT "succession_preferences_depth" CHECK ("succession_map_preferences"."depth" BETWEEN 2 AND 4),
	CONSTRAINT "succession_preferences_hidden" CHECK (jsonb_typeof("succession_map_preferences"."hidden_org_ids")='array'
    AND jsonb_array_length("succession_map_preferences"."hidden_org_ids")<=200),
	CONSTRAINT "succession_preferences_revision" CHECK ("succession_map_preferences"."revision">0)
);
--> statement-breakpoint
CREATE TABLE "succession_org_stats" (
	"tenant_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"stat_date" date NOT NULL,
	"on_duty_count" integer NOT NULL,
	"green_rate" numeric,
	"green_source_project_id" uuid,
	"slot_key" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"run_id" uuid NOT NULL,
	CONSTRAINT "succession_org_stats_tenant_id_org_id_stat_date_pk" PRIMARY KEY("tenant_id","org_id","stat_date"),
	CONSTRAINT "succession_stats_count" CHECK ("succession_org_stats"."on_duty_count">=0)
);
--> statement-breakpoint
ALTER TABLE "succession_map_preferences" ADD CONSTRAINT "succession_map_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_map_preferences" ADD CONSTRAINT "succession_map_preferences_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_map_preferences" ADD CONSTRAINT "succession_map_preferences_tenant_id_root_org_id_org_objects_tenant_id_id_fk" FOREIGN KEY ("tenant_id","root_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_org_stats" ADD CONSTRAINT "succession_org_stats_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_org_stats" ADD CONSTRAINT "succession_org_stats_tenant_id_org_id_org_objects_tenant_id_id_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_org_stats" ADD CONSTRAINT "succession_org_stats_tenant_id_run_id_succession_calc_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."succession_calc_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;