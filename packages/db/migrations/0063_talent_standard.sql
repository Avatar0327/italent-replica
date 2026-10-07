CREATE TABLE "talent_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"ability_note" text,
	"potential_note" text,
	"experience_note" text,
	"achievement_note" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_criteria_tenant_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "talent_criterion_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_criterion_categories_tenant_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "talent_criterion_dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"weight" numeric(5, 2),
	"target" numeric(8, 2),
	"display_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "talent_criterion_dimensions_once" UNIQUE("tenant_id","criterion_id","dimension_id"),
	CONSTRAINT "talent_criterion_dimensions_weight" CHECK ("talent_criterion_dimensions"."weight" BETWEEN 0 AND 100),
	CONSTRAINT "talent_criterion_dimensions_target" CHECK ("talent_criterion_dimensions"."target" >= 0)
);
--> statement-breakpoint
CREATE TABLE "talent_dimension_behaviors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"description" text NOT NULL,
	"key_points" text,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "talent_dimension_grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"grade_order" integer NOT NULL,
	"alias" text,
	"description" text,
	CONSTRAINT "talent_dimension_grades_order" UNIQUE("tenant_id","dimension_id","grade_order"),
	CONSTRAINT "talent_dimension_grades_order_range" CHECK ("talent_dimension_grades"."grade_order" BETWEEN 1 AND 99)
);
--> statement-breakpoint
CREATE TABLE "talent_dimension_libraries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_dimension_libraries_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_dimension_libraries_type" CHECK ("talent_dimension_libraries"."type" IN ('ability', 'potential', 'experience'))
);
--> statement-breakpoint
CREATE TABLE "talent_dimension_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"question" text NOT NULL,
	"key_points" text,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "talent_dimension_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"suggestion_type" text,
	"description" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "talent_dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"definition" text,
	"category" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_dimensions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_dimensions_code" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
ALTER TABLE "talent_criteria" ADD CONSTRAINT "talent_criteria_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_criteria" ADD CONSTRAINT "talent_criteria_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."talent_criterion_categories"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_criterion_categories" ADD CONSTRAINT "talent_criterion_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_criterion_dimensions" ADD CONSTRAINT "talent_criterion_dimensions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_criterion_dimensions" ADD CONSTRAINT "talent_criterion_dimensions_criterion_fk" FOREIGN KEY ("tenant_id","criterion_id") REFERENCES "public"."talent_criteria"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_criterion_dimensions" ADD CONSTRAINT "talent_criterion_dimensions_dimension_fk" FOREIGN KEY ("tenant_id","dimension_id") REFERENCES "public"."talent_dimensions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_dimension_behaviors" ADD CONSTRAINT "talent_dimension_behaviors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_dimension_behaviors" ADD CONSTRAINT "talent_dimension_behaviors_dimension_fk" FOREIGN KEY ("tenant_id","dimension_id") REFERENCES "public"."talent_dimensions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_dimension_grades" ADD CONSTRAINT "talent_dimension_grades_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_dimension_grades" ADD CONSTRAINT "talent_dimension_grades_dimension_fk" FOREIGN KEY ("tenant_id","dimension_id") REFERENCES "public"."talent_dimensions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_dimension_libraries" ADD CONSTRAINT "talent_dimension_libraries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_dimension_questions" ADD CONSTRAINT "talent_dimension_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_dimension_questions" ADD CONSTRAINT "talent_dimension_questions_dimension_fk" FOREIGN KEY ("tenant_id","dimension_id") REFERENCES "public"."talent_dimensions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_dimension_suggestions" ADD CONSTRAINT "talent_dimension_suggestions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_dimension_suggestions" ADD CONSTRAINT "talent_dimension_suggestions_dimension_fk" FOREIGN KEY ("tenant_id","dimension_id") REFERENCES "public"."talent_dimensions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_dimensions" ADD CONSTRAINT "talent_dimensions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_dimensions" ADD CONSTRAINT "talent_dimensions_library_fk" FOREIGN KEY ("tenant_id","library_id") REFERENCES "public"."talent_dimension_libraries"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "talent_criteria_category" ON "talent_criteria" USING btree ("tenant_id","category_id");--> statement-breakpoint
CREATE INDEX "talent_criterion_dimensions_dimension" ON "talent_criterion_dimensions" USING btree ("tenant_id","dimension_id");--> statement-breakpoint
CREATE INDEX "talent_dimension_behaviors_dimension" ON "talent_dimension_behaviors" USING btree ("tenant_id","dimension_id");--> statement-breakpoint
CREATE INDEX "talent_dimension_questions_dimension" ON "talent_dimension_questions" USING btree ("tenant_id","dimension_id");--> statement-breakpoint
CREATE INDEX "talent_dimension_suggestions_dimension" ON "talent_dimension_suggestions" USING btree ("tenant_id","dimension_id");--> statement-breakpoint
CREATE INDEX "talent_dimensions_library" ON "talent_dimensions" USING btree ("tenant_id","library_id");
--> statement-breakpoint
-- R3-T01：统一租户隔离（AGENTS §2；guard-rls）。删除走外键 RESTRICT / CASCADE，应用角色需要 DELETE。
SELECT enable_tenant_isolation('talent_dimension_libraries');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_dimension_libraries TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_dimensions');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_dimensions TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_dimension_grades');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_dimension_grades TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_dimension_behaviors');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_dimension_behaviors TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_dimension_suggestions');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_dimension_suggestions TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_dimension_questions');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_dimension_questions TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_criterion_categories');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_criterion_categories TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_criteria');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_criteria TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_criterion_dimensions');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_criterion_dimensions TO app_user;
