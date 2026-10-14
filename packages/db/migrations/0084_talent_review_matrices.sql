CREATE TABLE "talent_review_matrices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"x_field_id" uuid NOT NULL,
	"y_field_id" uuid NOT NULL,
	"z_field_id" uuid,
	"x_draggable" boolean DEFAULT false NOT NULL,
	"y_draggable" boolean DEFAULT false NOT NULL,
	"placement_source" text DEFAULT 'after_else_before' NOT NULL,
	"green_rate_reference" boolean DEFAULT false NOT NULL,
	"preset" boolean DEFAULT false NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_matrices_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_matrices_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "talent_review_matrices_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "talent_review_matrices_code_format" CHECK ("talent_review_matrices"."code" ~ '^[A-Za-z][A-Za-z0-9_]{0,49}$'),
	CONSTRAINT "talent_review_matrices_axes" CHECK ("talent_review_matrices"."x_field_id" <> "talent_review_matrices"."y_field_id"),
	CONSTRAINT "talent_review_matrices_source" CHECK ("talent_review_matrices"."placement_source" IN ('before','after','after_else_before')),
	CONSTRAINT "talent_review_matrices_rev" CHECK ("talent_review_matrices"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "talent_review_matrix_axis_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matrix_id" uuid NOT NULL,
	"axis" text NOT NULL,
	"level_no" smallint NOT NULL,
	"name" text NOT NULL,
	"option_values" text[] DEFAULT '{}'::text[] NOT NULL,
	"lower_bound" numeric(14, 4),
	CONSTRAINT "talent_review_matrix_axis_levels_no" UNIQUE("tenant_id","matrix_id","axis","level_no"),
	CONSTRAINT "talent_review_matrix_axis_levels_axis" CHECK ("talent_review_matrix_axis_levels"."axis" IN ('x','y')),
	CONSTRAINT "talent_review_matrix_axis_levels_no_range" CHECK ("talent_review_matrix_axis_levels"."level_no" BETWEEN 1 AND 9)
);
--> statement-breakpoint
CREATE TABLE "talent_review_matrix_cells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matrix_id" uuid NOT NULL,
	"cell_no" smallint NOT NULL,
	"x_level_no" smallint NOT NULL,
	"y_level_no" smallint NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"counts_green" boolean DEFAULT false NOT NULL,
	CONSTRAINT "talent_review_matrix_cells_no" UNIQUE("tenant_id","matrix_id","cell_no"),
	CONSTRAINT "talent_review_matrix_cells_color" CHECK ("talent_review_matrix_cells"."color" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "talent_review_matrix_cells_no_range" CHECK ("talent_review_matrix_cells"."cell_no" BETWEEN 1 AND 99)
);
--> statement-breakpoint
CREATE TABLE "talent_review_matrix_position_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matrix_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "talent_review_matrix_position_fields_field" UNIQUE("tenant_id","field_id"),
	CONSTRAINT "talent_review_matrix_position_fields_role" UNIQUE("tenant_id","matrix_id","role"),
	CONSTRAINT "talent_review_matrix_position_fields_role_check" CHECK ("talent_review_matrix_position_fields"."role" IN ('before','after'))
);
--> statement-breakpoint
CREATE TABLE "talent_review_ratio_rule_cells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"matrix_id" uuid NOT NULL,
	"cell_no" smallint NOT NULL,
	CONSTRAINT "talent_review_ratio_rule_cells_cell" UNIQUE("tenant_id","rule_id","cell_no")
);
--> statement-breakpoint
CREATE TABLE "talent_review_ratio_rule_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matrix_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"control_scope" text NOT NULL,
	"control_mode" text NOT NULL,
	"min_population" integer DEFAULT 0 NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_ratio_rule_groups_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_ratio_rule_groups_name" UNIQUE("tenant_id","matrix_id","name"),
	CONSTRAINT "talent_review_ratio_rule_groups_scope" CHECK ("talent_review_ratio_rule_groups"."control_scope" IN ('project_meeting','flow')),
	CONSTRAINT "talent_review_ratio_rule_groups_mode" CHECK ("talent_review_ratio_rule_groups"."control_mode" IN ('warn','block')),
	CONSTRAINT "talent_review_ratio_rule_groups_population" CHECK ("talent_review_ratio_rule_groups"."min_population" >= 0)
);
--> statement-breakpoint
CREATE TABLE "talent_review_ratio_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"operator" text NOT NULL,
	"pct_low" numeric(5, 2) NOT NULL,
	"pct_high" numeric(5, 2),
	"sort_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "talent_review_ratio_rules_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_ratio_rules_operator" CHECK ("talent_review_ratio_rules"."operator" IN ('gt','lt','gte','lte','between')),
	CONSTRAINT "talent_review_ratio_rules_pct" CHECK ("talent_review_ratio_rules"."pct_low" BETWEEN 0 AND 100),
	CONSTRAINT "talent_review_ratio_rules_between" CHECK (("talent_review_ratio_rules"."operator" = 'between') = ("talent_review_ratio_rules"."pct_high" IS NOT NULL)
        AND ("talent_review_ratio_rules"."pct_high" IS NULL OR "talent_review_ratio_rules"."pct_high" BETWEEN "talent_review_ratio_rules"."pct_low" AND 100))
);
--> statement-breakpoint
ALTER TABLE "talent_review_matrices" ADD CONSTRAINT "talent_review_matrices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_matrices" ADD CONSTRAINT "talent_review_matrices_x_field_fk" FOREIGN KEY ("tenant_id","x_field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_matrices" ADD CONSTRAINT "talent_review_matrices_y_field_fk" FOREIGN KEY ("tenant_id","y_field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_matrices" ADD CONSTRAINT "talent_review_matrices_z_field_fk" FOREIGN KEY ("tenant_id","z_field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_matrix_axis_levels" ADD CONSTRAINT "talent_review_matrix_axis_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_matrix_axis_levels" ADD CONSTRAINT "talent_review_matrix_axis_levels_matrix_fk" FOREIGN KEY ("tenant_id","matrix_id") REFERENCES "public"."talent_review_matrices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_matrix_cells" ADD CONSTRAINT "talent_review_matrix_cells_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_matrix_cells" ADD CONSTRAINT "talent_review_matrix_cells_matrix_fk" FOREIGN KEY ("tenant_id","matrix_id") REFERENCES "public"."talent_review_matrices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_matrix_position_fields" ADD CONSTRAINT "talent_review_matrix_position_fields_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_matrix_position_fields" ADD CONSTRAINT "talent_review_matrix_position_fields_matrix_fk" FOREIGN KEY ("tenant_id","matrix_id") REFERENCES "public"."talent_review_matrices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_matrix_position_fields" ADD CONSTRAINT "talent_review_matrix_position_fields_field_fk" FOREIGN KEY ("tenant_id","field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_ratio_rule_cells" ADD CONSTRAINT "talent_review_ratio_rule_cells_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_ratio_rule_cells" ADD CONSTRAINT "talent_review_ratio_rule_cells_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."talent_review_ratio_rules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_ratio_rule_cells" ADD CONSTRAINT "talent_review_ratio_rule_cells_cell_fk" FOREIGN KEY ("tenant_id","matrix_id","cell_no") REFERENCES "public"."talent_review_matrix_cells"("tenant_id","matrix_id","cell_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_ratio_rule_groups" ADD CONSTRAINT "talent_review_ratio_rule_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_ratio_rule_groups" ADD CONSTRAINT "talent_review_ratio_rule_groups_matrix_fk" FOREIGN KEY ("tenant_id","matrix_id") REFERENCES "public"."talent_review_matrices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_ratio_rules" ADD CONSTRAINT "talent_review_ratio_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_ratio_rules" ADD CONSTRAINT "talent_review_ratio_rules_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."talent_review_ratio_rule_groups"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "talent_review_ratio_rule_groups_default" ON "talent_review_ratio_rule_groups" USING btree ("tenant_id","matrix_id") WHERE "talent_review_ratio_rule_groups"."is_default";
--> statement-breakpoint
-- R3-T04 PR-B4：九宫格相关表统一租户隔离（AGENTS §2；guard-rls）。子表随九宫格整体增删，应用角色需要 DELETE。
SELECT enable_tenant_isolation('talent_review_matrices');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_matrix_position_fields');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_matrix_axis_levels');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_matrix_cells');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_ratio_rule_groups');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_ratio_rules');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_ratio_rule_cells');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_review_matrices, talent_review_matrix_position_fields, talent_review_matrix_axis_levels, talent_review_matrix_cells, talent_review_ratio_rule_groups, talent_review_ratio_rules, talent_review_ratio_rule_cells TO app_user;
