CREATE TABLE "succession_health_level_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"level_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"field_code" text,
	"filter_operator" text,
	"filter_values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"measure" text NOT NULL,
	"comparator" text NOT NULL,
	"threshold" double precision,
	"threshold_high" double precision,
	"is_percent" boolean DEFAULT false NOT NULL,
	"population" text NOT NULL,
	"population_id" uuid,
	"field_source" text NOT NULL,
	CONSTRAINT "succession_health_level_rows_tenant_id_level_id_row_no_unique" UNIQUE("tenant_id","level_id","row_no"),
	CONSTRAINT "succession_health_rows_number" CHECK ("succession_health_level_rows"."row_no" > 0),
	CONSTRAINT "succession_health_rows_population" CHECK ("succession_health_level_rows"."population" IN ('all', 'successors', 'incumbents', 'custom')
    AND (("succession_health_level_rows"."population" = 'custom') = ("succession_health_level_rows"."population_id" IS NOT NULL))),
	CONSTRAINT "succession_health_rows_source" CHECK ("succession_health_level_rows"."field_source" IN ('review', 'org', 'succession'))
);
--> statement-breakpoint
CREATE TABLE "succession_health_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"description" text,
	"display_order" integer NOT NULL,
	"condition_expression" text,
	"compiled_formula" text,
	"compiler_version" text,
	"compile_error" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "succession_health_levels_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "succession_health_levels_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "succession_health_levels_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "succession_health_levels_color" CHECK ("succession_health_levels"."color" ~ '^#[0-9A-Fa-f]{6}$'),
	CONSTRAINT "succession_health_levels_revision" CHECK ("succession_health_levels"."revision" > 0 AND "succession_health_levels"."display_order" > 0)
);
--> statement-breakpoint
CREATE TABLE "succession_risk_level_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"level_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"field_code" text,
	"filter_operator" text,
	"filter_values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"measure" text NOT NULL,
	"comparator" text NOT NULL,
	"threshold" double precision,
	"threshold_high" double precision,
	"is_percent" boolean DEFAULT false NOT NULL,
	"subject" text NOT NULL,
	CONSTRAINT "succession_risk_level_rows_tenant_id_level_id_row_no_unique" UNIQUE("tenant_id","level_id","row_no"),
	CONSTRAINT "succession_risk_rows_number" CHECK ("succession_risk_level_rows"."row_no" > 0),
	CONSTRAINT "succession_risk_rows_subject" CHECK ("succession_risk_level_rows"."subject" IN ('incumbent', 'successor')),
	CONSTRAINT "succession_risk_rows_measure" CHECK ("succession_risk_level_rows"."measure" IN ('count', 'count_over_incumbents', 'count_over_successors'))
);
--> statement-breakpoint
CREATE TABLE "succession_risk_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"description" text,
	"display_order" integer NOT NULL,
	"condition_expression" text,
	"compiled_formula" text,
	"compiler_version" text,
	"compile_error" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "succession_risk_levels_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "succession_risk_levels_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "succession_risk_levels_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "succession_risk_levels_color" CHECK ("succession_risk_levels"."color" ~ '^#[0-9A-Fa-f]{6}$'),
	CONSTRAINT "succession_risk_levels_revision" CHECK ("succession_risk_levels"."revision" > 0 AND "succession_risk_levels"."display_order" > 0)
);
--> statement-breakpoint
ALTER TABLE "succession_health_level_rows" ADD CONSTRAINT "succession_health_level_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_health_level_rows" ADD CONSTRAINT "succession_health_level_rows_tenant_id_level_id_succession_health_levels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."succession_health_levels"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_health_level_rows" ADD CONSTRAINT "succession_health_level_rows_tenant_id_population_id_succession_populations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","population_id") REFERENCES "public"."succession_populations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_health_levels" ADD CONSTRAINT "succession_health_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_risk_level_rows" ADD CONSTRAINT "succession_risk_level_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_risk_level_rows" ADD CONSTRAINT "succession_risk_level_rows_tenant_id_level_id_succession_risk_levels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."succession_risk_levels"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_risk_levels" ADD CONSTRAINT "succession_risk_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;