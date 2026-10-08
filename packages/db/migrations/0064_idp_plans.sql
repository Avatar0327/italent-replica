CREATE TABLE "idp_careers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"target_position_id" uuid,
	"strengths" text,
	"development_items" text,
	"intended_city" text,
	"start_date" date NOT NULL,
	"end_date" date,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_careers_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "idp_careers_key" UNIQUE NULLS NOT DISTINCT("tenant_id","employee_id","start_date","end_date"),
	CONSTRAINT "idp_careers_dates" CHECK ("idp_careers"."end_date" IS NULL OR "idp_careers"."end_date" >= "idp_careers"."start_date")
);
--> statement-breakpoint
CREATE TABLE "idp_goal_reviews" (
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"progress" integer,
	"outcome" text,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_goal_reviews_tenant_id_goal_id_stage_id_pk" PRIMARY KEY("tenant_id","goal_id","stage_id"),
	CONSTRAINT "idp_goal_reviews_progress" CHECK ("idp_goal_reviews"."progress" IS NULL OR "idp_goal_reviews"."progress" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "idp_goal_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_employee_id" uuid,
	"start_date" date,
	"end_date" date,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_goal_tasks_tenant_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "idp_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"name" text NOT NULL,
	"measure" text,
	"suggestion" text,
	"start_date" date,
	"end_date" date,
	"source_type" text NOT NULL,
	"common_goal_id" uuid,
	"indicator_id" uuid,
	"indicator_name" text,
	"indicator_definition" text,
	"indicator_category" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_goals_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "idp_goals_source" CHECK ("idp_goals"."source_type" IN ('custom', 'library', 'common'))
);
--> statement-breakpoint
CREATE TABLE "idp_plan_analyses" (
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"current_analysis" text,
	"development_items" text,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_plan_analyses_tenant_id_plan_id_module_id_pk" PRIMARY KEY("tenant_id","plan_id","module_id")
);
--> statement-breakpoint
CREATE TABLE "idp_plan_reviews" (
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"summary" text,
	"improvement" text,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_plan_reviews_tenant_id_plan_id_module_id_stage_id_pk" PRIMARY KEY("tenant_id","plan_id","module_id","stage_id")
);
--> statement-breakpoint
CREATE TABLE "idp_plan_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"sub_process_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approval_instance_id" uuid,
	"opened_at" timestamp with time zone,
	"ended_on" date,
	"failure_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_on" date,
	CONSTRAINT "idp_plan_stages_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "idp_plan_stages_seq" UNIQUE("tenant_id","plan_id","seq"),
	CONSTRAINT "idp_plan_stages_status" CHECK ("idp_plan_stages"."status" IN ('pending', 'running', 'ended', 'failed')),
	CONSTRAINT "idp_plan_stages_attempts" CHECK ("idp_plan_stages"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "idp_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"employee_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"tutor_role" text NOT NULL,
	"tutor_employee_id" uuid NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_plans_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "idp_plans_status" CHECK ("idp_plans"."status" IN ('not_started', 'running', 'ended', 'terminated')),
	CONSTRAINT "idp_plans_tutor_role" CHECK ("idp_plans"."tutor_role" IN ('direct_manager', 'indirect_manager', 'level3_head', 'level4_head', 'level5_head', 'mentor', 'department_hrbp', 'department_head', 'other')),
	CONSTRAINT "idp_plans_dates" CHECK ("idp_plans"."end_date" >= "idp_plans"."start_date")
);
--> statement-breakpoint
CREATE TABLE "idp_tutorships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tutor_employee_id" uuid NOT NULL,
	"tutee_employee_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"remark" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_tutorships_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "idp_tutorships_key" UNIQUE NULLS NOT DISTINCT("tenant_id","tutor_employee_id","tutee_employee_id","start_date","end_date"),
	CONSTRAINT "idp_tutorships_dates" CHECK ("idp_tutorships"."end_date" IS NULL OR "idp_tutorships"."end_date" >= "idp_tutorships"."start_date"),
	CONSTRAINT "idp_tutorships_distinct" CHECK ("idp_tutorships"."tutor_employee_id" <> "idp_tutorships"."tutee_employee_id")
);
--> statement-breakpoint
CREATE TABLE "idp_work_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"position_id" uuid,
	"post_id" uuid,
	"mentor_employee_id" uuid,
	"start_date" date NOT NULL,
	"end_date" date,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_work_shifts_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "idp_work_shifts_key" UNIQUE NULLS NOT DISTINCT("tenant_id","employee_id","org_id","position_id","post_id","start_date","end_date"),
	CONSTRAINT "idp_work_shifts_dates" CHECK ("idp_work_shifts"."end_date" IS NULL OR "idp_work_shifts"."end_date" >= "idp_work_shifts"."start_date")
);
--> statement-breakpoint
ALTER TABLE "approval_instances" DROP CONSTRAINT "approval_instances_business_type";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_approver";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_no_assignee";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_approvers";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "avoid_self" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "allow_revoke" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "allow_reject_previous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "allow_jump" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "idp_careers" ADD CONSTRAINT "idp_careers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_careers" ADD CONSTRAINT "idp_careers_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_careers" ADD CONSTRAINT "idp_careers_position_fk" FOREIGN KEY ("tenant_id","target_position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_goal_reviews" ADD CONSTRAINT "idp_goal_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_goal_reviews" ADD CONSTRAINT "idp_goal_reviews_plan_fk" FOREIGN KEY ("tenant_id","plan_id") REFERENCES "public"."idp_plans"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_goal_reviews" ADD CONSTRAINT "idp_goal_reviews_goal_fk" FOREIGN KEY ("tenant_id","goal_id") REFERENCES "public"."idp_goals"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_goal_reviews" ADD CONSTRAINT "idp_goal_reviews_stage_fk" FOREIGN KEY ("tenant_id","stage_id") REFERENCES "public"."idp_plan_stages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_goal_tasks" ADD CONSTRAINT "idp_goal_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_goal_tasks" ADD CONSTRAINT "idp_goal_tasks_plan_fk" FOREIGN KEY ("tenant_id","plan_id") REFERENCES "public"."idp_plans"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_goal_tasks" ADD CONSTRAINT "idp_goal_tasks_goal_fk" FOREIGN KEY ("tenant_id","goal_id") REFERENCES "public"."idp_goals"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_goal_tasks" ADD CONSTRAINT "idp_goal_tasks_owner_fk" FOREIGN KEY ("tenant_id","owner_employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_goals" ADD CONSTRAINT "idp_goals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_goals" ADD CONSTRAINT "idp_goals_plan_fk" FOREIGN KEY ("tenant_id","plan_id") REFERENCES "public"."idp_plans"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_goals" ADD CONSTRAINT "idp_goals_module_fk" FOREIGN KEY ("tenant_id","module_id") REFERENCES "public"."idp_template_modules"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_plan_analyses" ADD CONSTRAINT "idp_plan_analyses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_plan_analyses" ADD CONSTRAINT "idp_plan_analyses_plan_fk" FOREIGN KEY ("tenant_id","plan_id") REFERENCES "public"."idp_plans"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_plan_reviews" ADD CONSTRAINT "idp_plan_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_plan_reviews" ADD CONSTRAINT "idp_plan_reviews_plan_fk" FOREIGN KEY ("tenant_id","plan_id") REFERENCES "public"."idp_plans"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_plan_reviews" ADD CONSTRAINT "idp_plan_reviews_stage_fk" FOREIGN KEY ("tenant_id","stage_id") REFERENCES "public"."idp_plan_stages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_plan_stages" ADD CONSTRAINT "idp_plan_stages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_plan_stages" ADD CONSTRAINT "idp_plan_stages_plan_fk" FOREIGN KEY ("tenant_id","plan_id") REFERENCES "public"."idp_plans"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_plan_stages" ADD CONSTRAINT "idp_plan_stages_sub_process_fk" FOREIGN KEY ("tenant_id","sub_process_id") REFERENCES "public"."idp_sub_processes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_plans" ADD CONSTRAINT "idp_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_plans" ADD CONSTRAINT "idp_plans_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_plans" ADD CONSTRAINT "idp_plans_tutor_fk" FOREIGN KEY ("tenant_id","tutor_employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_plans" ADD CONSTRAINT "idp_plans_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."idp_templates"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_plans" ADD CONSTRAINT "idp_plans_process_fk" FOREIGN KEY ("tenant_id","process_id") REFERENCES "public"."idp_processes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_tutorships" ADD CONSTRAINT "idp_tutorships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_tutorships" ADD CONSTRAINT "idp_tutorships_tutor_fk" FOREIGN KEY ("tenant_id","tutor_employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_tutorships" ADD CONSTRAINT "idp_tutorships_tutee_fk" FOREIGN KEY ("tenant_id","tutee_employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_work_shifts" ADD CONSTRAINT "idp_work_shifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_work_shifts" ADD CONSTRAINT "idp_work_shifts_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_work_shifts" ADD CONSTRAINT "idp_work_shifts_mentor_fk" FOREIGN KEY ("tenant_id","mentor_employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_work_shifts" ADD CONSTRAINT "idp_work_shifts_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_work_shifts" ADD CONSTRAINT "idp_work_shifts_post_fk" FOREIGN KEY ("tenant_id","post_id") REFERENCES "public"."job_post_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_work_shifts" ADD CONSTRAINT "idp_work_shifts_org_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idp_goal_tasks_goal" ON "idp_goal_tasks" USING btree ("tenant_id","goal_id");--> statement-breakpoint
CREATE INDEX "idp_goals_plan" ON "idp_goals" USING btree ("tenant_id","plan_id");--> statement-breakpoint
CREATE INDEX "idp_plan_stages_pending" ON "idp_plan_stages" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idp_plan_stages_instance" ON "idp_plan_stages" USING btree ("tenant_id","approval_instance_id");--> statement-breakpoint
CREATE INDEX "idp_plans_employee" ON "idp_plans" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "idp_plans_tutor" ON "idp_plans" USING btree ("tenant_id","tutor_employee_id");--> statement-breakpoint
CREATE INDEX "idp_plans_template" ON "idp_plans" USING btree ("tenant_id","template_id");--> statement-breakpoint
CREATE INDEX "idp_tutorships_tutee" ON "idp_tutorships" USING btree ("tenant_id","tutee_employee_id");--> statement-breakpoint
CREATE INDEX "idp_work_shifts_org" ON "idp_work_shifts" USING btree ("tenant_id","org_id");--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_business_type" CHECK ("approval_instances"."business_type" IN ('employment','personnel_change','contract','idp'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_approver" CHECK ("approval_process_nodes"."approver_expression" IN ('owner','direct_manager','latest_record_department_head','record_department_head',
        'record_department_hrbp','record_first_level_org_head','idp_employee','idp_tutor'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_no_assignee" CHECK ("approval_process_nodes"."no_assignee_policy" IN ('exception_admin','none'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_approvers" CHECK (CASE WHEN "approval_process_nodes"."node_type" = 'countersign'
        THEN "approval_process_nodes"."approver_expression" IS NULL AND cardinality("approval_process_nodes"."approver_expressions") BETWEEN 1 AND 8
          AND "approval_process_nodes"."approver_expressions" <@ ARRAY['owner','direct_manager','latest_record_department_head',
            'record_department_head','record_department_hrbp','record_first_level_org_head',
            'idp_employee','idp_tutor']::text[]
        ELSE "approval_process_nodes"."approver_expression" IS NOT NULL AND cardinality("approval_process_nodes"."approver_expressions") = 0 END);--> statement-breakpoint
SELECT enable_tenant_isolation('idp_plans');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_plans TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('idp_plan_stages');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_plan_stages TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('idp_goals');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_goals TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('idp_goal_tasks');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_goal_tasks TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('idp_goal_reviews');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_goal_reviews TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('idp_plan_analyses');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_plan_analyses TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('idp_plan_reviews');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_plan_reviews TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('idp_tutorships');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_tutorships TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('idp_careers');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_careers TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('idp_work_shifts');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_work_shifts TO app_user;
