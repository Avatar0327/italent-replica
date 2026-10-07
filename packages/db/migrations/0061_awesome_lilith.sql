ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_approver";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_approvers";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_approver" CHECK ("approval_process_nodes"."approver_expression" IN ('owner','direct_manager','latest_record_department_head','record_department_head',
        'record_department_hrbp','record_first_level_org_head'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_approvers" CHECK (CASE WHEN "approval_process_nodes"."node_type" = 'countersign'
        THEN "approval_process_nodes"."approver_expression" IS NULL AND cardinality("approval_process_nodes"."approver_expressions") BETWEEN 1 AND 6
          AND "approval_process_nodes"."approver_expressions" <@ ARRAY['owner','direct_manager','latest_record_department_head',
            'record_department_head','record_department_hrbp','record_first_level_org_head']::text[]
        ELSE "approval_process_nodes"."approver_expression" IS NOT NULL AND cardinality("approval_process_nodes"."approver_expressions") = 0 END);