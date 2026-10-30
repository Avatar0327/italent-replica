CREATE TABLE "exit_handover_request_items" (
	"id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"category" text NOT NULL,
	"sequence_no" integer NOT NULL,
	"todo_type" text NOT NULL,
	"title" text NOT NULL,
	"form_ref" text,
	"remark" text,
	"done" boolean DEFAULT false NOT NULL,
	"done_at" timestamp with time zone,
	"done_by_user_id" uuid,
	"handover_person" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exit_handover_request_items_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "exit_handover_request_items_todo_type" CHECK ("exit_handover_request_items"."todo_type" IN ('work_handover', 'other')),
	CONSTRAINT "exit_handover_request_items_revision" CHECK ("exit_handover_request_items"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "exit_handover_requests" (
	"id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"exit_request_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"department_id" uuid,
	"initiator_user_id" uuid NOT NULL,
	"state" text NOT NULL,
	"end_reason" text,
	"approval_instance_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exit_handover_requests_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "exit_handover_requests_state" CHECK ("exit_handover_requests"."state" IN ('in_progress', 'completed', 'terminated')),
	CONSTRAINT "exit_handover_requests_end_reason" CHECK (("exit_handover_requests"."state" = 'terminated') = ("exit_handover_requests"."end_reason" IS NOT NULL)
        AND coalesce("exit_handover_requests"."end_reason", 'disapproved') IN ('disapproved', 'rejected', 'withdrawn', 'exit_cancelled')),
	CONSTRAINT "exit_handover_requests_revision" CHECK ("exit_handover_requests"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "approval_instances" DROP CONSTRAINT "approval_instances_business_type";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_approver";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_approvers";--> statement-breakpoint
ALTER TABLE "exit_handover_request_items" ADD CONSTRAINT "exit_handover_request_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_handover_request_items" ADD CONSTRAINT "exit_handover_request_items_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."exit_handover_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_handover_requests" ADD CONSTRAINT "exit_handover_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_handover_requests" ADD CONSTRAINT "exit_handover_requests_exit_fk" FOREIGN KEY ("tenant_id","exit_request_id") REFERENCES "public"."exit_requests"("tenant_id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exit_handover_request_items_list" ON "exit_handover_request_items" USING btree ("tenant_id","request_id","sequence_no","id");--> statement-breakpoint
CREATE UNIQUE INDEX "exit_handover_requests_live" ON "exit_handover_requests" USING btree ("tenant_id","exit_request_id") WHERE "exit_handover_requests"."state" IN ('in_progress', 'completed');--> statement-breakpoint
CREATE INDEX "exit_handover_requests_exit" ON "exit_handover_requests" USING btree ("tenant_id","exit_request_id");--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_business_type" CHECK ("approval_instances"."business_type" IN ('employment','personnel_change','contract','idp','talent_review','part_time',
        'offer','offer_batch','probation_assessment','retirement_intention','org_adjustment','exit_handover'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_approver" CHECK ("approval_process_nodes"."approver_expression" IN ('owner','direct_manager','latest_record_department_head','record_department_head',
        'record_department_hrbp','record_first_level_org_head','idp_employee','idp_tutor',
        'latest_record_department_hrbp','offer_department_head','initiator_direct_manager',
        'approval_subject_first_level_org_head','assessment_employee','approval_subject_org_hrbp',
        'approval_subject_org_head','handover_work_owner','handover_hr_admin','handover_employee'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_approvers" CHECK (CASE WHEN "approval_process_nodes"."node_type" = 'countersign'
        THEN "approval_process_nodes"."approver_expression" IS NULL AND cardinality("approval_process_nodes"."approver_expressions") BETWEEN 1 AND 8
          AND "approval_process_nodes"."approver_expressions" <@ ARRAY['owner','direct_manager','latest_record_department_head',
            'record_department_head','record_department_hrbp','record_first_level_org_head',
            'idp_employee','idp_tutor','latest_record_department_hrbp','offer_department_head',
            'initiator_direct_manager','approval_subject_first_level_org_head','assessment_employee',
            'approval_subject_org_hrbp','approval_subject_org_head',
            'handover_work_owner','handover_hr_admin','handover_employee']::text[]
        ELSE "approval_process_nodes"."approver_expression" IS NOT NULL AND cardinality("approval_process_nodes"."approver_expressions") = 0 END);--> statement-breakpoint
-- R2 BE-8b2（B64）：离职交接申请的租户隔离与授权。业务表不给 DELETE；交接申请创建后只有状态、终止原因、审批实例、
-- revision 可变，事项只有“办理完成”及其留痕列可变（事项内容是发起时的快照，冻结）。
SELECT enable_tenant_isolation('exit_handover_requests');
--> statement-breakpoint
SELECT enable_tenant_isolation('exit_handover_request_items');
--> statement-breakpoint
GRANT SELECT, INSERT ON exit_handover_requests, exit_handover_request_items TO app_user;
--> statement-breakpoint
GRANT UPDATE (state, end_reason, approval_instance_id, revision, command_id, updated_at)
  ON exit_handover_requests TO app_user;
--> statement-breakpoint
GRANT UPDATE (done, done_at, done_by_user_id, revision, updated_at) ON exit_handover_request_items TO app_user;
