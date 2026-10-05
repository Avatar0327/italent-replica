ALTER TABLE "approval_node_message_rules" DROP CONSTRAINT "approval_message_rules_trigger";--> statement-breakpoint
ALTER TABLE "approval_tasks" DROP CONSTRAINT "approval_tasks_status";--> statement-breakpoint
ALTER TABLE "approval_tasks" DROP CONSTRAINT "approval_tasks_origin";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ALTER COLUMN "approver_expression" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "node_type" text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "approver_expressions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "exits" text[] DEFAULT '{approve}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "transition_rule_type" text;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "approve_rule_kind" text;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "approve_rule_value" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "disagree_rule_kind" text;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "disagree_rule_value" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD COLUMN "activation_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_node_message_rules" ADD CONSTRAINT "approval_message_rules_trigger" CHECK ("approval_node_message_rules"."trigger" IN ('arrive','approve','disagree','reject','transfer'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_type" CHECK ("approval_process_nodes"."node_type" IN ('single','countersign'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_approvers" CHECK (CASE WHEN "approval_process_nodes"."node_type" = 'countersign'
        THEN "approval_process_nodes"."approver_expression" IS NULL AND cardinality("approval_process_nodes"."approver_expressions") BETWEEN 1 AND 5
          AND "approval_process_nodes"."approver_expressions" <@ ARRAY['owner','latest_record_department_head','record_department_head',
            'record_department_hrbp','record_first_level_org_head']::text[]
        ELSE "approval_process_nodes"."approver_expression" IS NOT NULL AND cardinality("approval_process_nodes"."approver_expressions") = 0 END);--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_exits" CHECK (cardinality("approval_process_nodes"."exits") BETWEEN 1 AND 2 AND "approval_process_nodes"."exits" <@ ARRAY['approve','disagree']::text[]);--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_countersign_auto" CHECK ("approval_process_nodes"."node_type" = 'single'
        OR ("approval_process_nodes"."same_assignee_result" = 'approve' AND "approval_process_nodes"."history_same_assignee_result" = 'approve'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_transition_rule" CHECK (("approval_process_nodes"."node_type" = 'countersign') = ("approval_process_nodes"."transition_rule_type" IS NOT NULL)
        AND ("approval_process_nodes"."transition_rule_type" IS NULL OR "approval_process_nodes"."transition_rule_type" IN ('any','all','custom'))
        AND CASE WHEN "approval_process_nodes"."transition_rule_type" = 'custom'
          THEN ("approval_process_nodes"."approve_rule_kind" IS NOT NULL) = ('approve' = ANY("approval_process_nodes"."exits"))
            AND ("approval_process_nodes"."disagree_rule_kind" IS NOT NULL) = ('disagree' = ANY("approval_process_nodes"."exits"))
          ELSE "approval_process_nodes"."approve_rule_kind" IS NULL AND "approval_process_nodes"."disagree_rule_kind" IS NULL END);--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_exit_rules" CHECK (("approval_process_nodes"."approve_rule_kind" IS NULL) = ("approval_process_nodes"."approve_rule_value" IS NULL)
        AND ("approval_process_nodes"."disagree_rule_kind" IS NULL) = ("approval_process_nodes"."disagree_rule_value" IS NULL)
        AND ("approval_process_nodes"."approve_rule_kind" IS NULL OR "approval_process_nodes"."approve_rule_kind" = 'count'
          AND "approval_process_nodes"."approve_rule_value" >= 1 AND "approval_process_nodes"."approve_rule_value" = trunc("approval_process_nodes"."approve_rule_value")
          OR "approval_process_nodes"."approve_rule_kind" = 'percent' AND "approval_process_nodes"."approve_rule_value" > 0 AND "approval_process_nodes"."approve_rule_value" <= 100)
        AND ("approval_process_nodes"."disagree_rule_kind" IS NULL OR "approval_process_nodes"."disagree_rule_kind" = 'count'
          AND "approval_process_nodes"."disagree_rule_value" >= 1 AND "approval_process_nodes"."disagree_rule_value" = trunc("approval_process_nodes"."disagree_rule_value")
          OR "approval_process_nodes"."disagree_rule_kind" = 'percent' AND "approval_process_nodes"."disagree_rule_value" > 0 AND "approval_process_nodes"."disagree_rule_value" <= 100));--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_status" CHECK ("approval_tasks"."status" IN ('pending','approved','disagreed','rejected','transferred','skipped','cancelled','add_signed',
        'queued','ended'));--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_origin" CHECK ("approval_tasks"."origin" IN ('resolved','self_skip','self_skip_manager','exception_admin','same_skip',
        'history_skip','no_assignee_skip','no_assignee_approve','transfer','add_sign','admin_transfer',
        'admin_intervene','blind_review','handover','add_sign_before','add_sign_after','add_sign_return','retrieve',
        'add_sign_parallel','countersign_reopen'));