CREATE TABLE "ql_ability_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"detail_id" uuid NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"target_value" text,
	"target_grade_id" uuid,
	"weight" numeric(7, 2),
	"display_order" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_target_id" uuid,
	CONSTRAINT "ql_ability_details_source" CHECK ("ql_ability_details"."source" IN ('manual', 'copied', 'common_overwrite')),
	CONSTRAINT "ql_ability_details_source_target" CHECK (("ql_ability_details"."source" = 'manual') = ("ql_ability_details"."source_target_id" IS NULL)),
	CONSTRAINT "ql_ability_details_weight" CHECK ("ql_ability_details"."weight" IS NULL OR "ql_ability_details"."weight" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "ql_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"class_id" uuid NOT NULL,
	"job_link_type" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"owner_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"public_down" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ql_categories_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ql_categories_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "ql_categories_code_format" CHECK ("ql_categories"."code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$'),
	CONSTRAINT "ql_categories_job_link_type" CHECK ("ql_categories"."job_link_type" IS NULL OR "ql_categories"."job_link_type" IN ('position', 'post', 'sequence', 'level_type'))
);
--> statement-breakpoint
CREATE TABLE "ql_category_classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"level" integer NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"owner_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"public_down" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ql_category_classes_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ql_category_classes_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "ql_category_classes_code_format" CHECK ("ql_category_classes"."code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$'),
	CONSTRAINT "ql_category_classes_level" CHECK ("ql_category_classes"."level" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "ql_category_job_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"job_link_type" text NOT NULL,
	"job_object_id" uuid NOT NULL,
	CONSTRAINT "ql_category_job_links_object" UNIQUE("tenant_id","job_link_type","job_object_id"),
	CONSTRAINT "ql_category_job_links_type" CHECK ("ql_category_job_links"."job_link_type" IN ('position', 'post', 'sequence', 'level_type'))
);
--> statement-breakpoint
CREATE TABLE "ql_coding_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"next_seq" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ql_coding_rules_item" UNIQUE("tenant_id","item"),
	CONSTRAINT "ql_coding_rules_item_check" CHECK ("ql_coding_rules"."item" IN ('category', 'level', 'target_type', 'target')),
	CONSTRAINT "ql_coding_rules_next_seq" CHECK ("ql_coding_rules"."next_seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ql_development_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"standard_id" uuid NOT NULL,
	"level_id" uuid NOT NULL,
	"target_category_id" uuid NOT NULL,
	"target_level_id" uuid NOT NULL,
	CONSTRAINT "ql_development_channels_path" UNIQUE("tenant_id","standard_id","level_id","target_category_id","target_level_id")
);
--> statement-breakpoint
CREATE TABLE "ql_grade_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scheme_id" uuid NOT NULL,
	"name" text NOT NULL,
	"grade" integer NOT NULL,
	"score" numeric(9, 2),
	"description" text,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ql_grade_details_tenant_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "ql_grade_schemes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ql_grade_schemes_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ql_grade_schemes_name" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "ql_layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ql_layers_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ql_layers_name" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "ql_level_descriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"standard_id" uuid NOT NULL,
	"level_id" uuid NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "ql_level_descriptions_pair" UNIQUE("tenant_id","standard_id","level_id")
);
--> statement-breakpoint
CREATE TABLE "ql_level_job_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"level_id" uuid NOT NULL,
	"job_link_type" text NOT NULL,
	"job_object_id" uuid NOT NULL,
	CONSTRAINT "ql_level_job_links_object" UNIQUE("tenant_id","job_link_type","job_object_id"),
	CONSTRAINT "ql_level_job_links_type" CHECK ("ql_level_job_links"."job_link_type" IN ('level', 'grade'))
);
--> statement-breakpoint
CREATE TABLE "ql_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"display_order" integer NOT NULL,
	"layer_id" uuid,
	"job_link_type" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"owner_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"public_down" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ql_levels_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ql_levels_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "ql_levels_display_order" UNIQUE("tenant_id","display_order"),
	CONSTRAINT "ql_levels_code_format" CHECK ("ql_levels"."code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$'),
	CONSTRAINT "ql_levels_job_link_type" CHECK ("ql_levels"."job_link_type" IS NULL OR "ql_levels"."job_link_type" IN ('level', 'grade'))
);
--> statement-breakpoint
CREATE TABLE "ql_standard_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"standard_id" uuid NOT NULL,
	"level_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_value" text,
	"weight" numeric(7, 2),
	CONSTRAINT "ql_standard_details_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ql_standard_details_cell" UNIQUE("tenant_id","standard_id","level_id","target_id"),
	CONSTRAINT "ql_standard_details_weight" CHECK ("ql_standard_details"."weight" IS NULL OR "ql_standard_details"."weight" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "ql_standards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"level_ids" uuid[] NOT NULL,
	"owner_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ql_standards_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ql_standards_category" UNIQUE("tenant_id","category_id"),
	CONSTRAINT "ql_standards_level_ids" CHECK (cardinality("ql_standards"."level_ids") BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "ql_target_grade_descriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"grade_detail_id" uuid NOT NULL,
	"description" text NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ql_target_grade_descriptions_pair" UNIQUE("tenant_id","target_id","grade_detail_id")
);
--> statement-breakpoint
CREATE TABLE "ql_target_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"display_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"owner_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"public_down" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ql_target_types_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ql_target_types_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "ql_target_types_code_format" CHECK ("ql_target_types"."code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$')
);
--> statement-breakpoint
CREATE TABLE "ql_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type_id" uuid NOT NULL,
	"description" text,
	"is_common" boolean DEFAULT false NOT NULL,
	"eval_mode" text NOT NULL,
	"grade_scheme_id" uuid,
	"display_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"owner_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"public_down" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ql_targets_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ql_targets_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "ql_targets_code_format" CHECK ("ql_targets"."code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$'),
	CONSTRAINT "ql_targets_eval_mode" CHECK (("ql_targets"."eval_mode" = 'score' AND "ql_targets"."grade_scheme_id" IS NULL)
        OR ("ql_targets"."eval_mode" = 'grade' AND "ql_targets"."grade_scheme_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "ql_ability_details" ADD CONSTRAINT "ql_ability_details_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_ability_details" ADD CONSTRAINT "ql_ability_details_detail_fk" FOREIGN KEY ("tenant_id","detail_id") REFERENCES "public"."ql_standard_details"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_ability_details" ADD CONSTRAINT "ql_ability_details_grade_fk" FOREIGN KEY ("tenant_id","target_grade_id") REFERENCES "public"."ql_grade_details"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_categories" ADD CONSTRAINT "ql_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_categories" ADD CONSTRAINT "ql_categories_class_fk" FOREIGN KEY ("tenant_id","class_id") REFERENCES "public"."ql_category_classes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_categories" ADD CONSTRAINT "ql_categories_owner_org_fk" FOREIGN KEY ("tenant_id","owner_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_category_classes" ADD CONSTRAINT "ql_category_classes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_category_classes" ADD CONSTRAINT "ql_category_classes_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."ql_category_classes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_category_classes" ADD CONSTRAINT "ql_category_classes_owner_org_fk" FOREIGN KEY ("tenant_id","owner_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_category_job_links" ADD CONSTRAINT "ql_category_job_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_category_job_links" ADD CONSTRAINT "ql_category_job_links_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."ql_categories"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_coding_rules" ADD CONSTRAINT "ql_coding_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_development_channels" ADD CONSTRAINT "ql_development_channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_development_channels" ADD CONSTRAINT "ql_development_channels_standard_fk" FOREIGN KEY ("tenant_id","standard_id") REFERENCES "public"."ql_standards"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_development_channels" ADD CONSTRAINT "ql_development_channels_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."ql_levels"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_development_channels" ADD CONSTRAINT "ql_development_channels_category_fk" FOREIGN KEY ("tenant_id","target_category_id") REFERENCES "public"."ql_categories"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_development_channels" ADD CONSTRAINT "ql_development_channels_target_level_fk" FOREIGN KEY ("tenant_id","target_level_id") REFERENCES "public"."ql_levels"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_grade_details" ADD CONSTRAINT "ql_grade_details_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_grade_details" ADD CONSTRAINT "ql_grade_details_scheme_fk" FOREIGN KEY ("tenant_id","scheme_id") REFERENCES "public"."ql_grade_schemes"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_grade_schemes" ADD CONSTRAINT "ql_grade_schemes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_layers" ADD CONSTRAINT "ql_layers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_level_descriptions" ADD CONSTRAINT "ql_level_descriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_level_descriptions" ADD CONSTRAINT "ql_level_descriptions_standard_fk" FOREIGN KEY ("tenant_id","standard_id") REFERENCES "public"."ql_standards"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_level_descriptions" ADD CONSTRAINT "ql_level_descriptions_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."ql_levels"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_level_job_links" ADD CONSTRAINT "ql_level_job_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_level_job_links" ADD CONSTRAINT "ql_level_job_links_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."ql_levels"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_levels" ADD CONSTRAINT "ql_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_levels" ADD CONSTRAINT "ql_levels_layer_fk" FOREIGN KEY ("tenant_id","layer_id") REFERENCES "public"."ql_layers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_levels" ADD CONSTRAINT "ql_levels_owner_org_fk" FOREIGN KEY ("tenant_id","owner_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_standard_details" ADD CONSTRAINT "ql_standard_details_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_standard_details" ADD CONSTRAINT "ql_standard_details_standard_fk" FOREIGN KEY ("tenant_id","standard_id") REFERENCES "public"."ql_standards"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_standard_details" ADD CONSTRAINT "ql_standard_details_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."ql_levels"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_standard_details" ADD CONSTRAINT "ql_standard_details_target_fk" FOREIGN KEY ("tenant_id","target_id") REFERENCES "public"."ql_targets"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_standards" ADD CONSTRAINT "ql_standards_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_standards" ADD CONSTRAINT "ql_standards_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."ql_categories"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_standards" ADD CONSTRAINT "ql_standards_owner_org_fk" FOREIGN KEY ("tenant_id","owner_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_target_grade_descriptions" ADD CONSTRAINT "ql_target_grade_descriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_target_grade_descriptions" ADD CONSTRAINT "ql_target_grade_descriptions_target_fk" FOREIGN KEY ("tenant_id","target_id") REFERENCES "public"."ql_targets"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_target_grade_descriptions" ADD CONSTRAINT "ql_target_grade_descriptions_detail_fk" FOREIGN KEY ("tenant_id","grade_detail_id") REFERENCES "public"."ql_grade_details"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_target_types" ADD CONSTRAINT "ql_target_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_target_types" ADD CONSTRAINT "ql_target_types_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."ql_target_types"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_target_types" ADD CONSTRAINT "ql_target_types_owner_org_fk" FOREIGN KEY ("tenant_id","owner_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_targets" ADD CONSTRAINT "ql_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_targets" ADD CONSTRAINT "ql_targets_type_fk" FOREIGN KEY ("tenant_id","type_id") REFERENCES "public"."ql_target_types"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_targets" ADD CONSTRAINT "ql_targets_grade_scheme_fk" FOREIGN KEY ("tenant_id","grade_scheme_id") REFERENCES "public"."ql_grade_schemes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ql_targets" ADD CONSTRAINT "ql_targets_owner_org_fk" FOREIGN KEY ("tenant_id","owner_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ql_ability_details_detail" ON "ql_ability_details" USING btree ("tenant_id","detail_id");--> statement-breakpoint
CREATE INDEX "ql_categories_class" ON "ql_categories" USING btree ("tenant_id","class_id");--> statement-breakpoint
CREATE INDEX "ql_categories_owner_org" ON "ql_categories" USING btree ("tenant_id","owner_org_id");--> statement-breakpoint
CREATE INDEX "ql_category_classes_parent" ON "ql_category_classes" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE INDEX "ql_category_classes_owner_org" ON "ql_category_classes" USING btree ("tenant_id","owner_org_id");--> statement-breakpoint
CREATE INDEX "ql_category_job_links_category" ON "ql_category_job_links" USING btree ("tenant_id","category_id");--> statement-breakpoint
CREATE INDEX "ql_grade_details_scheme" ON "ql_grade_details" USING btree ("tenant_id","scheme_id");--> statement-breakpoint
CREATE INDEX "ql_level_job_links_level" ON "ql_level_job_links" USING btree ("tenant_id","level_id");--> statement-breakpoint
CREATE INDEX "ql_levels_layer" ON "ql_levels" USING btree ("tenant_id","layer_id");--> statement-breakpoint
CREATE INDEX "ql_levels_owner_org" ON "ql_levels" USING btree ("tenant_id","owner_org_id");--> statement-breakpoint
CREATE INDEX "ql_standard_details_target" ON "ql_standard_details" USING btree ("tenant_id","target_id");--> statement-breakpoint
CREATE INDEX "ql_standards_owner_org" ON "ql_standards" USING btree ("tenant_id","owner_org_id");--> statement-breakpoint
CREATE INDEX "ql_target_types_parent" ON "ql_target_types" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE INDEX "ql_target_types_owner_org" ON "ql_target_types" USING btree ("tenant_id","owner_org_id");--> statement-breakpoint
CREATE INDEX "ql_targets_type" ON "ql_targets" USING btree ("tenant_id","type_id");--> statement-breakpoint
CREATE INDEX "ql_targets_grade_scheme" ON "ql_targets" USING btree ("tenant_id","grade_scheme_id");--> statement-breakpoint
CREATE INDEX "ql_targets_owner_org" ON "ql_targets" USING btree ("tenant_id","owner_org_id");--> statement-breakpoint
-- R3-T02 PR-A：统一租户隔离（AGENTS §2；guard-rls）。删除走外键 RESTRICT / CASCADE，应用角色需要 DELETE。
SELECT enable_tenant_isolation('ql_category_classes');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_category_classes TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_categories');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_categories TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_category_job_links');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_category_job_links TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_layers');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_layers TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_levels');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_levels TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_level_job_links');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_level_job_links TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_target_types');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_target_types TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_grade_schemes');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_grade_schemes TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_grade_details');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_grade_details TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_targets');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_targets TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_target_grade_descriptions');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_target_grade_descriptions TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_coding_rules');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_coding_rules TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_standards');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_standards TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_standard_details');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_standard_details TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_ability_details');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_ability_details TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_level_descriptions');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_level_descriptions TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ql_development_channels');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ql_development_channels TO app_user;
