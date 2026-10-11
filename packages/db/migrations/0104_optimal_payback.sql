CREATE TABLE "succession_population_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"population_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"field_code" text NOT NULL,
	"filter_operator" text NOT NULL,
	"filter_values" jsonb NOT NULL,
	CONSTRAINT "succession_population_rows_tenant_id_population_id_row_no_unique" UNIQUE("tenant_id","population_id","row_no"),
	CONSTRAINT "succession_population_rows_number" CHECK ("succession_population_rows"."row_no" BETWEEN 1 AND 2147483647)
);
--> statement-breakpoint
CREATE TABLE "succession_populations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"condition_expression" text NOT NULL,
	"compiled_formula" text,
	"compiler_version" text,
	"compile_error" jsonb,
	"display_order" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "succession_populations_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "succession_populations_tenant_id_code_unique" UNIQUE("tenant_id","code"),
	CONSTRAINT "succession_populations_revision" CHECK ("succession_populations"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "succession_rule_settings" (
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"default_color" text NOT NULL,
	"levels_revision" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "succession_rule_settings_tenant_id_kind_pk" PRIMARY KEY("tenant_id","kind"),
	CONSTRAINT "succession_rule_settings_kind" CHECK ("succession_rule_settings"."kind" IN ('position_risk', 'org_health')),
	CONSTRAINT "succession_rule_settings_color" CHECK ("succession_rule_settings"."default_color" ~ '^#[0-9A-Fa-f]{6}$'),
	CONSTRAINT "succession_rule_settings_revision" CHECK ("succession_rule_settings"."revision" >= 0 AND "succession_rule_settings"."levels_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "succession_population_rows" ADD CONSTRAINT "succession_population_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_population_rows" ADD CONSTRAINT "succession_population_rows_tenant_id_population_id_succession_populations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","population_id") REFERENCES "public"."succession_populations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_populations" ADD CONSTRAINT "succession_populations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "succession_rule_settings" ADD CONSTRAINT "succession_rule_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;