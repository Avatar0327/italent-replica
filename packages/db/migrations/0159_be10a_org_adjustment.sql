CREATE TABLE "org_adjustment_org_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"adjust_type" smallint NOT NULL,
	"target_org_id" uuid,
	"base_version_id" uuid,
	"base_org_revision" integer,
	"cascaded_from_item_id" uuid,
	"name" text,
	"code" text,
	"short_name" text,
	"parent_org_id" uuid,
	"parent_item_id" uuid,
	"display_order" integer,
	"level" smallint,
	"half_level" smallint,
	"update_descendant_levels" boolean,
	"person_in_charge_id" uuid,
	"hrbp_id" uuid,
	"add_employment" boolean,
	"transfer_old_head_subordinates" boolean,
	"adjust_new_head_manager" boolean,
	"new_head_manager_id" uuid,
	"sync_establishment" boolean,
	"deactivation_establishment_mode" smallint,
	"establishment_transfer_amount" integer,
	"batch_transfer" boolean,
	"transfer_to_org_id" uuid,
	"transfer_to_item_id" uuid,
	"is_staged" boolean DEFAULT false NOT NULL,
	"old_custom_fields" jsonb,
	"new_custom_fields" jsonb,
	"created_org_id" uuid,
	"executed_version_id" uuid,
	"execution_result" smallint,
	"execution_reason" text,
	"execution_message" text,
	"exec_phase" smallint DEFAULT 0 NOT NULL,
	"employment_cursor" uuid,
	"employment_done" integer DEFAULT 0 NOT NULL,
	"employment_failed" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "org_adjustment_org_items_tenant_item" UNIQUE("tenant_id","adjustment_id","id"),
	CONSTRAINT "org_adjustment_org_items_seq" UNIQUE("tenant_id","adjustment_id","seq"),
	CONSTRAINT "org_adjustment_org_items_target" UNIQUE("tenant_id","adjustment_id","target_org_id"),
	CONSTRAINT "org_adjustment_org_items_type" CHECK ("org_adjustment_org_items"."adjust_type" IN (1, 2, 3)),
	CONSTRAINT "org_adjustment_org_items_target_shape" CHECK (("org_adjustment_org_items"."adjust_type" = 1) = ("org_adjustment_org_items"."target_org_id" IS NULL)),
	CONSTRAINT "org_adjustment_org_items_seq_positive" CHECK ("org_adjustment_org_items"."seq" > 0),
	CONSTRAINT "org_adjustment_org_items_level" CHECK ("org_adjustment_org_items"."level" IS NULL OR "org_adjustment_org_items"."level" BETWEEN 1 AND 10),
	CONSTRAINT "org_adjustment_org_items_half_level" CHECK ("org_adjustment_org_items"."half_level" IS NULL OR "org_adjustment_org_items"."half_level" IN (1, 2)),
	CONSTRAINT "org_adjustment_org_items_deactivation_mode" CHECK ("org_adjustment_org_items"."deactivation_establishment_mode" IS NULL OR "org_adjustment_org_items"."deactivation_establishment_mode" IN (1, 2)),
	CONSTRAINT "org_adjustment_org_items_parent_exclusive" CHECK ("org_adjustment_org_items"."parent_org_id" IS NULL OR "org_adjustment_org_items"."parent_item_id" IS NULL),
	CONSTRAINT "org_adjustment_org_items_transfer_exclusive" CHECK ("org_adjustment_org_items"."transfer_to_org_id" IS NULL OR "org_adjustment_org_items"."transfer_to_item_id" IS NULL),
	CONSTRAINT "org_adjustment_org_items_amount" CHECK ("org_adjustment_org_items"."establishment_transfer_amount" IS NULL OR "org_adjustment_org_items"."establishment_transfer_amount" >= 0),
	CONSTRAINT "org_adjustment_org_items_result" CHECK ("org_adjustment_org_items"."execution_result" IS NULL OR "org_adjustment_org_items"."execution_result" IN (1, 2)),
	CONSTRAINT "org_adjustment_org_items_phase" CHECK ("org_adjustment_org_items"."exec_phase" IN (0, 1, 2)),
	CONSTRAINT "org_adjustment_org_items_progress" CHECK ("org_adjustment_org_items"."employment_done" >= 0 AND "org_adjustment_org_items"."employment_failed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "org_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"subject" text NOT NULL,
	"effective_date" date NOT NULL,
	"scope_note" text,
	"content" text,
	"approval_subject_org_id" uuid NOT NULL,
	"approval_status" smallint DEFAULT 0 NOT NULL,
	"execution_status" smallint DEFAULT 1 NOT NULL,
	"execution_note" text,
	"data_volume" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"approved_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_adjustments_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "org_adjustments_tenant_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "org_adjustments_approval_status" CHECK ("org_adjustments"."approval_status" IN (0, 1, 2, 3, 4, 5, 6)),
	CONSTRAINT "org_adjustments_execution_status" CHECK ("org_adjustments"."execution_status" IN (1, 2, 3)),
	CONSTRAINT "org_adjustments_subject" CHECK (btrim("org_adjustments"."subject") <> '' AND char_length("org_adjustments"."subject") <= 100),
	CONSTRAINT "org_adjustments_scope_note" CHECK (char_length(COALESCE("org_adjustments"."scope_note", '')) <= 500),
	CONSTRAINT "org_adjustments_content" CHECK (char_length(COALESCE("org_adjustments"."content", '')) <= 2000),
	CONSTRAINT "org_adjustments_counts" CHECK ("org_adjustments"."data_volume" >= 0 AND "org_adjustments"."success_count" >= 0 AND "org_adjustments"."failure_count" >= 0),
	CONSTRAINT "org_adjustments_revision_positive" CHECK ("org_adjustments"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "employment_payload_versions" DROP CONSTRAINT "employment_payload_versions_change_type";--> statement-breakpoint
ALTER TABLE "employment_records" DROP CONSTRAINT "employment_records_change_type";--> statement-breakpoint
ALTER TABLE "approval_instances" DROP CONSTRAINT "approval_instances_business_type";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_approver";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_approvers";--> statement-breakpoint
ALTER TABLE "org_adjustment_org_items" ADD CONSTRAINT "org_adjustment_org_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_org_items" ADD CONSTRAINT "org_adjustment_org_items_adjustment_fk" FOREIGN KEY ("tenant_id","adjustment_id") REFERENCES "public"."org_adjustments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_org_items" ADD CONSTRAINT "org_adjustment_org_items_cascade_fk" FOREIGN KEY ("tenant_id","adjustment_id","cascaded_from_item_id") REFERENCES "public"."org_adjustment_org_items"("tenant_id","adjustment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_org_items" ADD CONSTRAINT "org_adjustment_org_items_parent_item_fk" FOREIGN KEY ("tenant_id","adjustment_id","parent_item_id") REFERENCES "public"."org_adjustment_org_items"("tenant_id","adjustment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_org_items" ADD CONSTRAINT "org_adjustment_org_items_transfer_item_fk" FOREIGN KEY ("tenant_id","adjustment_id","transfer_to_item_id") REFERENCES "public"."org_adjustment_org_items"("tenant_id","adjustment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_org_items" ADD CONSTRAINT "org_adjustment_org_items_target_fk" FOREIGN KEY ("tenant_id","target_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_org_items" ADD CONSTRAINT "org_adjustment_org_items_parent_org_fk" FOREIGN KEY ("tenant_id","parent_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_org_items" ADD CONSTRAINT "org_adjustment_org_items_transfer_org_fk" FOREIGN KEY ("tenant_id","transfer_to_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_org_items" ADD CONSTRAINT "org_adjustment_org_items_created_org_fk" FOREIGN KEY ("tenant_id","created_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_org_items" ADD CONSTRAINT "org_adjustment_org_items_base_version_fk" FOREIGN KEY ("tenant_id","base_version_id") REFERENCES "public"."org_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_org_items" ADD CONSTRAINT "org_adjustment_org_items_executed_version_fk" FOREIGN KEY ("tenant_id","executed_version_id") REFERENCES "public"."org_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_org_items" ADD CONSTRAINT "org_adjustment_org_items_head_fk" FOREIGN KEY ("tenant_id","person_in_charge_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_org_items" ADD CONSTRAINT "org_adjustment_org_items_hrbp_fk" FOREIGN KEY ("tenant_id","hrbp_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_org_items" ADD CONSTRAINT "org_adjustment_org_items_new_manager_fk" FOREIGN KEY ("tenant_id","new_head_manager_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustments" ADD CONSTRAINT "org_adjustments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustments" ADD CONSTRAINT "org_adjustments_subject_org_fk" FOREIGN KEY ("tenant_id","approval_subject_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustments" ADD CONSTRAINT "org_adjustments_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_adjustment_org_items_created_org" ON "org_adjustment_org_items" USING btree ("tenant_id","created_org_id") WHERE "org_adjustment_org_items"."created_org_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "org_adjustments_subject_org" ON "org_adjustments" USING btree ("tenant_id","approval_subject_org_id","effective_date");--> statement-breakpoint
CREATE INDEX "org_adjustments_status" ON "org_adjustments" USING btree ("tenant_id","approval_status","created_at");--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_change_type" CHECK ("employment_payload_versions"."change_type" IN ('position_adjustment', 'intern_regularization', 'intern_end', 'org_adjustment'));--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_change_type" CHECK ("employment_records"."change_type" IN ('position_adjustment', 'intern_regularization', 'intern_end', 'org_adjustment'));--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_business_type" CHECK ("approval_instances"."business_type" IN ('employment','personnel_change','contract','idp','talent_review','part_time',
        'offer','offer_batch','probation_assessment','retirement_intention','org_adjustment'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_approver" CHECK ("approval_process_nodes"."approver_expression" IN ('owner','direct_manager','latest_record_department_head','record_department_head',
        'record_department_hrbp','record_first_level_org_head','idp_employee','idp_tutor',
        'latest_record_department_hrbp','offer_department_head','initiator_direct_manager',
        'approval_subject_first_level_org_head','assessment_employee','approval_subject_org_hrbp',
        'approval_subject_org_head'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_approvers" CHECK (CASE WHEN "approval_process_nodes"."node_type" = 'countersign'
        THEN "approval_process_nodes"."approver_expression" IS NULL AND cardinality("approval_process_nodes"."approver_expressions") BETWEEN 1 AND 8
          AND "approval_process_nodes"."approver_expressions" <@ ARRAY['owner','direct_manager','latest_record_department_head',
            'record_department_head','record_department_hrbp','record_first_level_org_head',
            'idp_employee','idp_tutor','latest_record_department_hrbp','offer_department_head',
            'initiator_direct_manager','approval_subject_first_level_org_head','assessment_employee',
            'approval_subject_org_hrbp','approval_subject_org_head']::text[]
        ELSE "approval_process_nodes"."approver_expression" IS NOT NULL AND cardinality("approval_process_nodes"."approver_expressions") = 0 END);--> statement-breakpoint
-- R2-T08 BE-10a 手写部分：租户隔离与应用角色权限（同 0150）。申请单头不物理删除（作废是状态 5），可改的列逐列授权：
-- 编号、创建人、创建时间创建后不可改；明细可增删改（删除明细连带行与生成行由服务端写，§6.2），所属单据与顺序之外的列都可改。
SELECT enable_tenant_isolation('org_adjustments');
--> statement-breakpoint
SELECT enable_tenant_isolation('org_adjustment_org_items');
--> statement-breakpoint
GRANT SELECT, INSERT ON org_adjustments TO app_user;
--> statement-breakpoint
GRANT UPDATE (subject, effective_date, scope_note, content, approval_subject_org_id, approval_status, execution_status,
  execution_note, data_volume, success_count, failure_count, approved_at, executed_at, revision, updated_at)
  ON org_adjustments TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON org_adjustment_org_items TO app_user;
