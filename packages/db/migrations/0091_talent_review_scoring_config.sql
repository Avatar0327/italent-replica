CREATE TABLE "talent_review_field_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scene" text NOT NULL,
	"source_field_id" uuid NOT NULL,
	"target_field_id" uuid NOT NULL,
	"preset" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_field_mappings_pair" UNIQUE("tenant_id","scene","source_field_id","target_field_id"),
	CONSTRAINT "talent_review_field_mappings_scene" CHECK ("talent_review_field_mappings"."scene" IN ('carry_last','talent_pool')),
	CONSTRAINT "talent_review_field_mappings_rev" CHECK ("talent_review_field_mappings"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "talent_review_module_grade_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"grade_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	"min_score" numeric(14, 4),
	"max_score" numeric(14, 4),
	"min_count" integer,
	CONSTRAINT "talent_review_module_grade_items_name" UNIQUE("tenant_id","grade_id","name"),
	CONSTRAINT "talent_review_module_grade_items_value" UNIQUE("tenant_id","grade_id","value"),
	CONSTRAINT "talent_review_module_grade_items_shape" CHECK (("talent_review_module_grade_items"."min_count" IS NOT NULL AND "talent_review_module_grade_items"."min_count" >= 0 AND "talent_review_module_grade_items"."min_score" IS NULL AND "talent_review_module_grade_items"."max_score" IS NULL)
        OR ("talent_review_module_grade_items"."min_count" IS NULL AND "talent_review_module_grade_items"."min_score" IS NOT NULL AND "talent_review_module_grade_items"."max_score" > "talent_review_module_grade_items"."min_score"))
);
--> statement-breakpoint
CREATE TABLE "talent_review_module_grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_module_grades_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_module_grades_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "talent_review_module_grades_rev" CHECK ("talent_review_module_grades"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "talent_review_score_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" numeric(14, 4) NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "talent_review_score_levels_name" UNIQUE("tenant_id","rule_id","name")
);
--> statement-breakpoint
CREATE TABLE "talent_review_score_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"min_score" numeric(14, 4),
	"max_score" numeric(14, 4),
	"display" text,
	"allow_unable" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_score_rules_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_score_rules_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "talent_review_score_rules_shape" CHECK (("talent_review_score_rules"."kind" = 'numeric' AND "talent_review_score_rules"."min_score" IS NOT NULL AND "talent_review_score_rules"."max_score" > "talent_review_score_rules"."min_score"
        AND "talent_review_score_rules"."display" IS NULL)
        OR ("talent_review_score_rules"."kind" = 'grade' AND "talent_review_score_rules"."min_score" IS NULL AND "talent_review_score_rules"."max_score" IS NULL
        AND "talent_review_score_rules"."display" IN ('dropdown','tile'))),
	CONSTRAINT "talent_review_score_rules_rev" CHECK ("talent_review_score_rules"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "talent_review_field_mappings" ADD CONSTRAINT "talent_review_field_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_field_mappings" ADD CONSTRAINT "talent_review_field_mappings_source_fk" FOREIGN KEY ("tenant_id","source_field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_field_mappings" ADD CONSTRAINT "talent_review_field_mappings_target_fk" FOREIGN KEY ("tenant_id","target_field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_module_grade_items" ADD CONSTRAINT "talent_review_module_grade_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_module_grade_items" ADD CONSTRAINT "talent_review_module_grade_items_grade_fk" FOREIGN KEY ("tenant_id","grade_id") REFERENCES "public"."talent_review_module_grades"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_module_grades" ADD CONSTRAINT "talent_review_module_grades_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_score_levels" ADD CONSTRAINT "talent_review_score_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_score_levels" ADD CONSTRAINT "talent_review_score_levels_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."talent_review_score_rules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_score_rules" ADD CONSTRAINT "talent_review_score_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_score_rules');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_score_levels');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_module_grades');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_module_grade_items');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_field_mappings');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_review_score_rules, talent_review_score_levels, talent_review_module_grades, talent_review_module_grade_items, talent_review_field_mappings TO app_user;
