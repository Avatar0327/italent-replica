CREATE TABLE "org_code_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"user_id" uuid NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_code_reservations_state_valid" CHECK ("org_code_reservations"."state" IN ('held', 'released', 'consumed')),
	CONSTRAINT "org_code_reservations_revision_positive" CHECK ("org_code_reservations"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "org_hierarchy_links" (
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"parent_org_id" uuid,
	"sequence" integer,
	CONSTRAINT "org_hierarchy_links_tenant_id_version_id_dimension_pk" PRIMARY KEY("tenant_id","version_id","dimension"),
	CONSTRAINT "org_hierarchy_dimension_valid" CHECK ("org_hierarchy_links"."dimension" IN ('admin', 'business', 'product', 'reserve4', 'reserve5'))
);
--> statement-breakpoint
CREATE TABLE "org_import_mappings" (
	"tenant_id" uuid NOT NULL,
	"source_code" text NOT NULL,
	"org_id" uuid NOT NULL,
	CONSTRAINT "org_import_mappings_tenant_id_source_code_pk" PRIMARY KEY("tenant_id","source_code")
);
--> statement-breakpoint
CREATE TABLE "org_import_results" (
	"tenant_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"row_index" integer NOT NULL,
	"source_code" text NOT NULL,
	"status" text NOT NULL,
	"org_id" uuid,
	"reason" text,
	"code" text NOT NULL,
	CONSTRAINT "org_import_results_tenant_id_command_id_row_index_pk" PRIMARY KEY("tenant_id","command_id","row_index"),
	CONSTRAINT "org_import_results_status_valid" CHECK ("org_import_results"."status" IN ('created', 'updated', 'conflict')),
	CONSTRAINT "org_import_results_row_index_nonnegative" CHECK ("org_import_results"."row_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "org_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_objects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "org_objects_tenant_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "org_objects_code_nonempty" CHECK (btrim("org_objects"."code") <> ''),
	CONSTRAINT "org_objects_revision_positive" CHECK ("org_objects"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "org_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"business_enabled" boolean DEFAULT false NOT NULL,
	"product_enabled" boolean DEFAULT false NOT NULL,
	"reserve4_enabled" boolean DEFAULT false NOT NULL,
	"reserve5_enabled" boolean DEFAULT false NOT NULL,
	"full_name_start_level" integer DEFAULT 0 NOT NULL,
	"next_code_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "org_settings_revision_nonnegative" CHECK ("org_settings"."revision" >= 0),
	CONSTRAINT "org_settings_full_name_level_nonnegative" CHECK ("org_settings"."full_name_start_level" >= 0),
	CONSTRAINT "org_settings_next_code_positive" CHECK ("org_settings"."next_code_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "org_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"start_date" date NOT NULL,
	"stop_date" date DEFAULT '9999-12-31' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"name" text NOT NULL,
	"short_name" text,
	"broad_type" text DEFAULT '部门' NOT NULL,
	"established_on" date,
	"person_in_charge_id" uuid,
	"hrbp_id" uuid,
	"cost_center_id" uuid,
	"location" text,
	"remarks" text,
	"full_name" text NOT NULL,
	"display_order" integer,
	"is_virtual" boolean DEFAULT false NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "org_versions_tenant_org_id" UNIQUE("tenant_id","org_id","id"),
	CONSTRAINT "org_versions_tenant_org_version" UNIQUE("tenant_id","org_id","version_no"),
	CONSTRAINT "org_versions_name_nonempty" CHECK (btrim("org_versions"."name") <> ''),
	CONSTRAINT "org_versions_version_positive" CHECK ("org_versions"."version_no" > 0),
	CONSTRAINT "org_versions_dates_valid" CHECK ("org_versions"."stop_date" >= "org_versions"."start_date"),
	CONSTRAINT "org_versions_level_nonnegative" CHECK ("org_versions"."level" >= 0)
);
--> statement-breakpoint
ALTER TABLE "org_code_reservations" ADD CONSTRAINT "org_code_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_code_reservations" ADD CONSTRAINT "org_code_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_hierarchy_links" ADD CONSTRAINT "org_hierarchy_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_hierarchy_links" ADD CONSTRAINT "org_hierarchy_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."org_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_hierarchy_links" ADD CONSTRAINT "org_hierarchy_parent_fk" FOREIGN KEY ("tenant_id","parent_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_import_mappings" ADD CONSTRAINT "org_import_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_import_mappings" ADD CONSTRAINT "org_import_mappings_object_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_import_results" ADD CONSTRAINT "org_import_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_import_results" ADD CONSTRAINT "org_import_results_object_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_objects" ADD CONSTRAINT "org_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_versions" ADD CONSTRAINT "org_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_versions" ADD CONSTRAINT "org_versions_object_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_versions" ADD CONSTRAINT "org_versions_previous_fk" FOREIGN KEY ("tenant_id","org_id","previous_version_id") REFERENCES "public"."org_versions"("tenant_id","org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_code_reservations_held_code" ON "org_code_reservations" USING btree ("tenant_id","code") WHERE "org_code_reservations"."state" = 'held';--> statement-breakpoint
CREATE INDEX "org_code_reservations_tenant_state" ON "org_code_reservations" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "org_hierarchy_tenant_parent" ON "org_hierarchy_links" USING btree ("tenant_id","dimension","parent_org_id");--> statement-breakpoint
CREATE INDEX "org_versions_tenant_as_of" ON "org_versions" USING btree ("tenant_id","org_id","start_date","version_no");