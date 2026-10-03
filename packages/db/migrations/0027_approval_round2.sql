ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_no_assignee";--> statement-breakpoint
ALTER TABLE "approval_tasks" DROP CONSTRAINT "approval_tasks_origin";--> statement-breakpoint
ALTER TABLE "approval_instances" ADD COLUMN "business_version" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD COLUMN "condition_values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_no_assignee" CHECK ("approval_process_nodes"."no_assignee_policy" = 'exception_admin');--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_origin" CHECK ("approval_tasks"."origin" IN ('resolved','self_skip','self_skip_manager','exception_admin','same_skip',
        'history_skip','no_assignee_skip','no_assignee_approve','transfer','add_sign','admin_transfer',
        'admin_intervene','blind_review','handover'));