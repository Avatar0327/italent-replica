CREATE TABLE "talent_review_project_calibration_fields" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	CONSTRAINT "talent_review_project_calibration_fields_tenant_id_project_id_field_id_pk" PRIMARY KEY("tenant_id","project_id","field_id")
);
--> statement-breakpoint
CREATE TABLE "talent_review_project_excluded_categories" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "talent_review_project_excluded_categories_tenant_id_project_id_category_id_pk" PRIMARY KEY("tenant_id","project_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "talent_review_project_matrices" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"matrix_id" uuid NOT NULL,
	"ratio_group_id" uuid,
	"sort_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "talent_review_project_matrices_tenant_id_project_id_matrix_id_pk" PRIMARY KEY("tenant_id","project_id","matrix_id")
);
--> statement-breakpoint
CREATE TABLE "talent_review_project_shared_orgs" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	CONSTRAINT "talent_review_project_shared_orgs_tenant_id_project_id_org_id_pk" PRIMARY KEY("tenant_id","project_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "talent_review_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid,
	"owner_org_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"downward_public" boolean DEFAULT false NOT NULL,
	"year" integer NOT NULL,
	"period" text NOT NULL,
	"period_start_date" date NOT NULL,
	"period_end_date" date NOT NULL,
	"business_date" date,
	"last_full_calc_at" timestamp with time zone,
	"calc_state" text DEFAULT 'not_calculated' NOT NULL,
	"calc_rule_id" uuid,
	"carry_last_result" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"ended_count" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_projects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_projects_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "talent_review_projects_dates" CHECK ("talent_review_projects"."period_start_date" <= "talent_review_projects"."period_end_date"),
	CONSTRAINT "talent_review_projects_status" CHECK ("talent_review_projects"."status" IN ('new','in_progress','ended')),
	CONSTRAINT "talent_review_projects_calc_state" CHECK ("talent_review_projects"."calc_state" IN ('not_calculated','calculating','success','failed')),
	CONSTRAINT "talent_review_projects_ended_count" CHECK ("talent_review_projects"."ended_count" >= 0),
	CONSTRAINT "talent_review_projects_rev" CHECK ("talent_review_projects"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "talent_review_project_calibration_fields" ADD CONSTRAINT "talent_review_project_calibration_fields_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_project_calibration_fields" ADD CONSTRAINT "tr_project_calibration_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."talent_review_projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_project_calibration_fields" ADD CONSTRAINT "tr_project_calibration_field_fk" FOREIGN KEY ("tenant_id","field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_project_excluded_categories" ADD CONSTRAINT "talent_review_project_excluded_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_project_excluded_categories" ADD CONSTRAINT "tr_project_excluded_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."talent_review_projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_project_excluded_categories" ADD CONSTRAINT "tr_project_excluded_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."talent_review_categories"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_project_matrices" ADD CONSTRAINT "talent_review_project_matrices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_project_matrices" ADD CONSTRAINT "tr_project_matrix_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."talent_review_projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_project_matrices" ADD CONSTRAINT "tr_project_matrix_matrix_fk" FOREIGN KEY ("tenant_id","matrix_id") REFERENCES "public"."talent_review_matrices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_project_matrices" ADD CONSTRAINT "tr_project_matrix_group_fk" FOREIGN KEY ("tenant_id","ratio_group_id") REFERENCES "public"."talent_review_ratio_rule_groups"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_project_shared_orgs" ADD CONSTRAINT "talent_review_project_shared_orgs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_project_shared_orgs" ADD CONSTRAINT "tr_project_shared_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."talent_review_projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_project_shared_orgs" ADD CONSTRAINT "talent_review_project_shared_orgs_tenant_id_org_id_org_objects_tenant_id_id_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_projects" ADD CONSTRAINT "talent_review_projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_projects" ADD CONSTRAINT "talent_review_projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_projects" ADD CONSTRAINT "talent_review_projects_tenant_id_owner_org_id_org_objects_tenant_id_id_fk" FOREIGN KEY ("tenant_id","owner_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_projects" ADD CONSTRAINT "talent_review_projects_tenant_id_category_id_talent_review_categories_tenant_id_id_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."talent_review_categories"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_projects" ADD CONSTRAINT "talent_review_projects_tenant_id_calc_rule_id_talent_review_calc_rules_tenant_id_id_fk" FOREIGN KEY ("tenant_id","calc_rule_id") REFERENCES "public"."talent_review_calc_rules"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "talent_review_projects_org" ON "talent_review_projects" USING btree ("tenant_id","owner_org_id");
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_projects');

--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_project_shared_orgs');

--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_project_excluded_categories');

--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_project_matrices');

--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_project_calibration_fields');

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_review_projects, talent_review_project_shared_orgs, talent_review_project_excluded_categories, talent_review_project_matrices, talent_review_project_calibration_fields TO app_user;
