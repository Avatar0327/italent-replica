CREATE TABLE "employment_probation_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"anchor_id" uuid NOT NULL,
	"department_id" uuid,
	"assessment_type" text NOT NULL,
	"assessment_name" text NOT NULL,
	"assessment_date" date NOT NULL,
	"self_evaluation" text,
	"manager_rating" text,
	"regularization_opinion" text,
	"regularization_date" date,
	"status" text NOT NULL,
	"initiation" text DEFAULT 'manual' NOT NULL,
	"initiator_user_id" uuid NOT NULL,
	"system_proxy" boolean DEFAULT false NOT NULL,
	"regularization_business_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_probation_assessments_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_probation_assessments_type" CHECK ("employment_probation_assessments"."assessment_type" IN ('probation', 'regularization')),
	CONSTRAINT "employment_probation_assessments_status" CHECK ("employment_probation_assessments"."status" IN ('in_review', 'approved', 'rejected', 'disapproved', 'cancelled')),
	CONSTRAINT "employment_probation_assessments_initiation" CHECK ("employment_probation_assessments"."initiation" IN ('manual', 'auto')),
	CONSTRAINT "employment_probation_assessments_name" CHECK (btrim("employment_probation_assessments"."assessment_name") <> '' AND char_length("employment_probation_assessments"."assessment_name") <= 100),
	CONSTRAINT "employment_probation_assessments_rating" CHECK ("employment_probation_assessments"."manager_rating" IS NULL OR "employment_probation_assessments"."manager_rating" IN ('average', 'meets', 'exceeds', 'below')),
	CONSTRAINT "employment_probation_assessments_opinion" CHECK ("employment_probation_assessments"."regularization_opinion" IS NULL
        OR "employment_probation_assessments"."regularization_opinion" IN ('normal', 'early', 'delayed', 'failed', 'extended')),
	CONSTRAINT "employment_probation_assessments_date" CHECK ("employment_probation_assessments"."regularization_opinion" IS NULL OR "employment_probation_assessments"."regularization_opinion" NOT IN ('early', 'delayed')
        OR "employment_probation_assessments"."regularization_date" IS NOT NULL),
	CONSTRAINT "employment_probation_assessments_text" CHECK (char_length(COALESCE("employment_probation_assessments"."self_evaluation", '')) <= 2000),
	CONSTRAINT "employment_probation_assessments_revision_positive" CHECK ("employment_probation_assessments"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "approval_instances" DROP CONSTRAINT "approval_instances_business_type";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_approver";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_approvers";--> statement-breakpoint
ALTER TABLE "employment_probation_assessments" ADD CONSTRAINT "employment_probation_assessments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_probation_assessments" ADD CONSTRAINT "employment_probation_assessments_anchor_fk" FOREIGN KEY ("tenant_id","employee_id","anchor_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_probation_assessments" ADD CONSTRAINT "employment_probation_assessments_regularization_fk" FOREIGN KEY ("tenant_id","employee_id","regularization_business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employment_probation_assessments_employee" ON "employment_probation_assessments" USING btree ("tenant_id","employee_id","status");--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_business_type" CHECK ("approval_instances"."business_type" IN ('employment','personnel_change','contract','idp','talent_review','part_time',
        'offer','offer_batch','probation_assessment'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_approver" CHECK ("approval_process_nodes"."approver_expression" IN ('owner','direct_manager','latest_record_department_head','record_department_head',
        'record_department_hrbp','record_first_level_org_head','idp_employee','idp_tutor',
        'latest_record_department_hrbp','offer_department_head','initiator_direct_manager',
        'approval_subject_first_level_org_head','assessment_employee'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_approvers" CHECK (CASE WHEN "approval_process_nodes"."node_type" = 'countersign'
        THEN "approval_process_nodes"."approver_expression" IS NULL AND cardinality("approval_process_nodes"."approver_expressions") BETWEEN 1 AND 8
          AND "approval_process_nodes"."approver_expressions" <@ ARRAY['owner','direct_manager','latest_record_department_head',
            'record_department_head','record_department_hrbp','record_first_level_org_head',
            'idp_employee','idp_tutor','latest_record_department_hrbp','offer_department_head',
            'initiator_direct_manager','approval_subject_first_level_org_head','assessment_employee']::text[]
        ELSE "approval_process_nodes"."approver_expression" IS NOT NULL AND cardinality("approval_process_nodes"."approver_expressions") = 0 END);--> statement-breakpoint
-- R2 BE-15b1 手写部分：考核记录的租户隔离与应用角色权限（同 0144）。可改的列逐列授权：审批回写状态 / 生成的转正业务，
-- 审批中编辑与审批通过后改意见写评价字段；考核对象、周期、类型、发起人创建后不可改
SELECT enable_tenant_isolation('employment_probation_assessments');
--> statement-breakpoint
GRANT SELECT, INSERT ON employment_probation_assessments TO app_user;
--> statement-breakpoint
GRANT UPDATE (assessment_name, assessment_date, self_evaluation, manager_rating, regularization_opinion, regularization_date,
  status, regularization_business_id, revision, command_id, updated_at) ON employment_probation_assessments TO app_user;
--> statement-breakpoint
-- 考核并行规则（PB-R9 例外，R2e5）：两个开关各带“可发起流程”多选，两层配置，出厂都关
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('probation.assessment_parallel.probation_assessment','{"enabled":false,"allowed":[]}'::jsonb,
    '试用期：试用中考核流程并行规则（enabled 开关；allowed 为审批中仍可发起的流程）',true,1,now()),
  ('probation.assessment_parallel.regularization_assessment','{"enabled":false,"allowed":[]}'::jsonb,
    '试用期：转正考核流程并行规则（enabled 开关；allowed 为审批中仍可发起的流程）',true,1,now());
