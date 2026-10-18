CREATE TABLE "offer_batch_approval_items" (
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	CONSTRAINT "offer_batch_approval_items_tenant_id_batch_id_offer_id_pk" PRIMARY KEY("tenant_id","batch_id","offer_id"),
	CONSTRAINT "offer_batch_approval_items_seq" UNIQUE("tenant_id","batch_id","seq"),
	CONSTRAINT "offer_batch_approval_items_seq_positive" CHECK ("offer_batch_approval_items"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "offer_batch_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"approval_subject_org_id" uuid NOT NULL,
	"remark" text,
	"status" text DEFAULT 'approving' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_batch_approvals_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "offer_batch_approvals_status" CHECK ("offer_batch_approvals"."status" IN ('approving', 'approved', 'disapproved', 'returned', 'withdrawn', 'cancelled')),
	CONSTRAINT "offer_batch_approvals_revision" CHECK ("offer_batch_approvals"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "approval_instances" DROP CONSTRAINT "approval_instances_business_type";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_approver";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_approvers";--> statement-breakpoint
ALTER TABLE "offer_batch_approval_items" ADD CONSTRAINT "offer_batch_approval_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_batch_approval_items" ADD CONSTRAINT "offer_batch_approval_items_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."offer_batch_approvals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_batch_approval_items" ADD CONSTRAINT "offer_batch_approval_items_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."offers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_batch_approvals" ADD CONSTRAINT "offer_batch_approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_batch_approvals" ADD CONSTRAINT "offer_batch_approvals_subject_org_fk" FOREIGN KEY ("tenant_id","approval_subject_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_batch_approval_items_offer" ON "offer_batch_approval_items" USING btree ("tenant_id","offer_id");--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_business_type" CHECK ("approval_instances"."business_type" IN ('employment','personnel_change','contract','idp','talent_review','part_time',
        'offer','offer_batch'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_approver" CHECK ("approval_process_nodes"."approver_expression" IN ('owner','direct_manager','latest_record_department_head','record_department_head',
        'record_department_hrbp','record_first_level_org_head','idp_employee','idp_tutor',
        'latest_record_department_hrbp','offer_department_head','initiator_direct_manager',
        'approval_subject_first_level_org_head'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_approvers" CHECK (CASE WHEN "approval_process_nodes"."node_type" = 'countersign'
        THEN "approval_process_nodes"."approver_expression" IS NULL AND cardinality("approval_process_nodes"."approver_expressions") BETWEEN 1 AND 8
          AND "approval_process_nodes"."approver_expressions" <@ ARRAY['owner','direct_manager','latest_record_department_head',
            'record_department_head','record_department_hrbp','record_first_level_org_head',
            'idp_employee','idp_tutor','latest_record_department_hrbp','offer_department_head',
            'initiator_direct_manager','approval_subject_first_level_org_head']::text[]
        ELSE "approval_process_nodes"."approver_expression" IS NOT NULL AND cardinality("approval_process_nodes"."approver_expressions") = 0 END);--> statement-breakpoint
-- BE-14a3 手写部分：批量审批单的租户隔离与应用角色权限（同 0139_offers）。状态与 revision 由审批回写更新，子表只增。
SELECT enable_tenant_isolation('offer_batch_approvals');
--> statement-breakpoint
GRANT SELECT, INSERT ON offer_batch_approvals TO app_user;
--> statement-breakpoint
GRANT UPDATE (status, revision, updated_at) ON offer_batch_approvals TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('offer_batch_approval_items');
--> statement-breakpoint
GRANT SELECT, INSERT ON offer_batch_approval_items TO app_user;
