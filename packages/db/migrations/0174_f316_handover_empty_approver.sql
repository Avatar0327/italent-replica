ALTER TABLE "approval_process_nodes" ADD COLUMN "empty_approver_policy" text;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_empty_approver" CHECK ("approval_process_nodes"."empty_approver_policy" IS NULL OR (
      "approval_process_nodes"."node_type" = 'countersign' AND (
        ("approval_process_nodes"."node_key" = 'work_handover' AND "approval_process_nodes"."empty_approver_policy" IN ('stop','auto_approve','specified')) OR
        ("approval_process_nodes"."node_key" = 'other_handover' AND "approval_process_nodes"."empty_approver_policy" IN ('exception_admin','auto_approve','specified'))
      ) AND ("approval_process_nodes"."empty_approver_policy" <> 'auto_approve' OR 'approve' = ANY("approval_process_nodes"."exits"))
    ));