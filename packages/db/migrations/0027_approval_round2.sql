CREATE TABLE "personnel_change_request_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"values" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personnel_change_request_versions_no" UNIQUE("tenant_id","request_id","version_no"),
	CONSTRAINT "personnel_change_request_versions_positive" CHECK ("personnel_change_request_versions"."version_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "approval_instance_ccs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"comment" text,
	"created_by" uuid NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_notifications" DROP CONSTRAINT "approval_notifications_kind";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_no_assignee";--> statement-breakpoint
ALTER TABLE "approval_tasks" DROP CONSTRAINT "approval_tasks_status";--> statement-breakpoint
ALTER TABLE "approval_tasks" DROP CONSTRAINT "approval_tasks_origin";--> statement-breakpoint
ALTER TABLE "approval_instances" ADD COLUMN "business_version" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD COLUMN "condition_values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "allow_copy_send" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "allow_retrieve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "urge_mode" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "comment_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "personnel_change_request_versions" ADD CONSTRAINT "personnel_change_request_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_change_request_versions" ADD CONSTRAINT "personnel_change_request_versions_request_fk" FOREIGN KEY ("tenant_id","employee_id","request_id") REFERENCES "public"."personnel_change_requests"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instance_ccs" ADD CONSTRAINT "approval_instance_ccs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instance_ccs" ADD CONSTRAINT "approval_ccs_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."approval_instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instance_ccs" ADD CONSTRAINT "approval_ccs_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_ccs_user" ON "approval_instance_ccs" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "approval_ccs_instance" ON "approval_instance_ccs" USING btree ("tenant_id","instance_id");--> statement-breakpoint
ALTER TABLE "approval_notifications" ADD CONSTRAINT "approval_notifications_kind" CHECK ("approval_notifications"."kind" IN ('todo','urge','message','cc'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_urge_mode" CHECK ("approval_process_nodes"."urge_mode" IN ('inherit','enabled','disabled'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_no_assignee" CHECK ("approval_process_nodes"."no_assignee_policy" = 'exception_admin');--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_status" CHECK ("approval_tasks"."status" IN ('pending','approved','rejected','transferred','skipped','cancelled','add_signed'));--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_origin" CHECK ("approval_tasks"."origin" IN ('resolved','self_skip','self_skip_manager','exception_admin','same_skip',
        'history_skip','no_assignee_skip','no_assignee_approve','transfer','add_sign','admin_transfer',
        'admin_intervene','blind_review','handover','add_sign_before','add_sign_after','add_sign_return','retrieve'));--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP COLUMN "allow_urge";