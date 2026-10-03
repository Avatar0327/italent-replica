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
CREATE TABLE "approval_instance_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"round" integer NOT NULL,
	"node_key" text,
	"task_id" uuid,
	"event" text NOT NULL,
	"actor_user_id" uuid,
	"admin_self_transfer" boolean DEFAULT false NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_logs_seq" UNIQUE("tenant_id","instance_id","seq")
);
--> statement-breakpoint
CREATE TABLE "approval_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"approval_type" text NOT NULL,
	"object_code" text NOT NULL,
	"business_type" text NOT NULL,
	"business_id" uuid NOT NULL,
	"subject_employee_id" uuid,
	"initiator_user_id" uuid NOT NULL,
	"process_code" text,
	"title" text NOT NULL,
	"business_version" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"current_node_key" text,
	"returned_from_node_key" text,
	"round" integer DEFAULT 1 NOT NULL,
	"history_from_seq" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "approval_instances_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "approval_instances_status" CHECK ("approval_instances"."status" IN ('running','returned','approved','withdrawn','cancelled')),
	CONSTRAINT "approval_instances_business_type" CHECK ("approval_instances"."business_type" IN ('employment','personnel_change')),
	CONSTRAINT "approval_instances_revision" CHECK ("approval_instances"."revision" > 0 AND "approval_instances"."round" > 0 AND "approval_instances"."history_from_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "approval_node_message_rules" (
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"rule_no" integer NOT NULL,
	"trigger" text NOT NULL,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"template_code" text NOT NULL,
	"recipient" text NOT NULL,
	CONSTRAINT "approval_node_message_rules_tenant_id_version_id_node_key_rule_no_pk" PRIMARY KEY("tenant_id","version_id","node_key","rule_no"),
	CONSTRAINT "approval_message_rules_trigger" CHECK ("approval_node_message_rules"."trigger" IN ('arrive','approve','reject','transfer')),
	CONSTRAINT "approval_message_rules_recipient" CHECK ("approval_node_message_rules"."recipient" IN ('owner','subject_employee','assignee')),
	CONSTRAINT "approval_message_rules_channels" CHECK (cardinality("approval_node_message_rules"."channels") > 0 AND "approval_node_message_rules"."channels" <@ ARRAY['inbox','email','sms']::text[])
);
--> statement-breakpoint
CREATE TABLE "approval_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"task_id" uuid,
	"recipient_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"template_code" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_notifications_kind" CHECK ("approval_notifications"."kind" IN ('todo','urge','message','cc')),
	CONSTRAINT "approval_notifications_channel" CHECK ("approval_notifications"."channel" IN ('inbox','email','sms')),
	CONSTRAINT "approval_notifications_status" CHECK ("approval_notifications"."status" IN ('pending','sent','failed','unknown'))
);
--> statement-breakpoint
CREATE TABLE "approval_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"object_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"revision" integer NOT NULL,
	"command_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_outbox_event" UNIQUE("tenant_id","command_id","object_id","event_type"),
	CONSTRAINT "approval_outbox_state" CHECK ("approval_outbox"."state" IN ('pending','sent','failed','unknown'))
);
--> statement-breakpoint
CREATE TABLE "approval_process_conditions" (
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"item_no" integer NOT NULL,
	"field_path" text NOT NULL,
	"operator" text NOT NULL,
	"value_text" text,
	"value_list" text[],
	CONSTRAINT "approval_process_conditions_tenant_id_version_id_item_no_pk" PRIMARY KEY("tenant_id","version_id","item_no"),
	CONSTRAINT "approval_conditions_operator" CHECK ("approval_process_conditions"."operator" IN ('eq','ne','in','not_in','is_empty','not_empty','in_org_tree'))
);
--> statement-breakpoint
CREATE TABLE "approval_process_nodes" (
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"approver_expression" text NOT NULL,
	"no_assignee_policy" text DEFAULT 'exception_admin' NOT NULL,
	"same_assignee_skip" boolean DEFAULT false NOT NULL,
	"history_same_assignee_skip" boolean DEFAULT false NOT NULL,
	"same_assignee_result" text DEFAULT 'approve' NOT NULL,
	"history_same_assignee_result" text DEFAULT 'approve' NOT NULL,
	"form_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"editable_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"edit_mode" text DEFAULT 'none' NOT NULL,
	"allow_transfer" boolean DEFAULT false NOT NULL,
	"allow_add_sign" boolean DEFAULT false NOT NULL,
	"allow_copy_send" boolean DEFAULT false NOT NULL,
	"allow_retrieve" boolean DEFAULT false NOT NULL,
	"urge_mode" text DEFAULT 'inherit' NOT NULL,
	"reject_comment_required" boolean DEFAULT false NOT NULL,
	"hide_records" boolean DEFAULT false NOT NULL,
	"reject_resubmit_mode" text DEFAULT 'restart' NOT NULL,
	"time_span" integer,
	"time_effect_before" jsonb,
	"time_effect" jsonb,
	"period" jsonb,
	CONSTRAINT "approval_process_nodes_tenant_id_version_id_node_key_pk" PRIMARY KEY("tenant_id","version_id","node_key"),
	CONSTRAINT "approval_nodes_seq" UNIQUE("tenant_id","version_id","seq"),
	CONSTRAINT "approval_nodes_approver" CHECK ("approval_process_nodes"."approver_expression" IN ('owner','latest_record_department_head','record_department_head',
        'record_department_hrbp','record_first_level_org_head')),
	CONSTRAINT "approval_nodes_no_assignee" CHECK ("approval_process_nodes"."no_assignee_policy" = 'exception_admin'),
	CONSTRAINT "approval_nodes_edit_mode" CHECK ("approval_process_nodes"."edit_mode" IN ('none','separate','with_approve')),
	CONSTRAINT "approval_nodes_resubmit" CHECK ("approval_process_nodes"."reject_resubmit_mode" IN ('restart','rejecting_node')),
	CONSTRAINT "approval_nodes_seq_positive" CHECK ("approval_process_nodes"."seq" > 0),
	CONSTRAINT "approval_nodes_urge_mode" CHECK ("approval_process_nodes"."urge_mode" IN ('inherit','enabled','disabled')),
	CONSTRAINT "approval_nodes_auto_result" CHECK ("approval_process_nodes"."same_assignee_result" IN ('approve','skip') AND "approval_process_nodes"."history_same_assignee_result" IN ('approve','skip'))
);
--> statement-breakpoint
CREATE TABLE "approval_process_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"name" text NOT NULL,
	"group_name" text,
	"description" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_fallback" boolean DEFAULT false NOT NULL,
	"exception_admin_user_id" uuid,
	"urge_enabled" boolean DEFAULT true NOT NULL,
	"hide_records_from_initiator" boolean DEFAULT false NOT NULL,
	"condition_expression" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	CONSTRAINT "approval_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "approval_versions_number" UNIQUE("tenant_id","process_id","version_no"),
	CONSTRAINT "approval_versions_status" CHECK ("approval_process_versions"."status" IN ('draft','published')),
	CONSTRAINT "approval_versions_number_positive" CHECK ("approval_process_versions"."version_no" > 0),
	CONSTRAINT "approval_versions_priority" CHECK ("approval_process_versions"."priority" BETWEEN -100000 AND 100000),
	CONSTRAINT "approval_versions_published" CHECK (("approval_process_versions"."status" = 'draft') = ("approval_process_versions"."published_at" IS NULL)
        AND ("approval_process_versions"."status" = 'draft' OR "approval_process_versions"."exception_admin_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "approval_processes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"approval_type" text NOT NULL,
	"object_code" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_version_id" uuid,
	"latest_version_no" integer DEFAULT 1 NOT NULL,
	"preset_key" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_processes_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "approval_processes_status" CHECK ("approval_processes"."status" IN ('active','discarded')),
	CONSTRAINT "approval_processes_revision" CHECK ("approval_processes"."revision" > 0 AND "approval_processes"."latest_version_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "approval_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"round" integer NOT NULL,
	"node_key" text NOT NULL,
	"assignee_user_id" uuid,
	"candidate_user_id" uuid,
	"origin" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"is_exception_admin" boolean DEFAULT false NOT NULL,
	"admin_self_transfer" boolean DEFAULT false NOT NULL,
	"parent_task_id" uuid,
	"comment" text,
	"acted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_tasks_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "approval_tasks_seq" UNIQUE("tenant_id","instance_id","seq"),
	CONSTRAINT "approval_tasks_pending_assignee" CHECK ("approval_tasks"."status" <> 'pending' OR "approval_tasks"."assignee_user_id" IS NOT NULL),
	CONSTRAINT "approval_tasks_status" CHECK ("approval_tasks"."status" IN ('pending','approved','rejected','transferred','skipped','cancelled','add_signed','queued')),
	CONSTRAINT "approval_tasks_origin" CHECK ("approval_tasks"."origin" IN ('resolved','self_skip','self_skip_manager','exception_admin','same_skip',
        'history_skip','no_assignee_skip','no_assignee_approve','transfer','add_sign','admin_transfer',
        'admin_intervene','blind_review','handover','add_sign_before','add_sign_after','add_sign_return','retrieve'))
);
--> statement-breakpoint
ALTER TABLE "personnel_change_requests" DROP CONSTRAINT "personnel_change_requests_state";--> statement-breakpoint
ALTER TABLE "personnel_change_request_versions" ADD CONSTRAINT "personnel_change_request_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_change_request_versions" ADD CONSTRAINT "personnel_change_request_versions_request_fk" FOREIGN KEY ("tenant_id","employee_id","request_id") REFERENCES "public"."personnel_change_requests"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instance_ccs" ADD CONSTRAINT "approval_instance_ccs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instance_ccs" ADD CONSTRAINT "approval_ccs_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."approval_instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instance_ccs" ADD CONSTRAINT "approval_ccs_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instance_logs" ADD CONSTRAINT "approval_instance_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instance_logs" ADD CONSTRAINT "approval_logs_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."approval_instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_process_fk" FOREIGN KEY ("tenant_id","process_id") REFERENCES "public"."approval_processes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."approval_process_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_subject_fk" FOREIGN KEY ("tenant_id","subject_employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_initiator_fk" FOREIGN KEY ("tenant_id","initiator_user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_node_message_rules" ADD CONSTRAINT "approval_node_message_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_node_message_rules" ADD CONSTRAINT "approval_message_rules_node_fk" FOREIGN KEY ("tenant_id","version_id","node_key") REFERENCES "public"."approval_process_nodes"("tenant_id","version_id","node_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_notifications" ADD CONSTRAINT "approval_notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_notifications" ADD CONSTRAINT "approval_notifications_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."approval_instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_notifications" ADD CONSTRAINT "approval_notifications_recipient_fk" FOREIGN KEY ("tenant_id","recipient_user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_outbox" ADD CONSTRAINT "approval_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_process_conditions" ADD CONSTRAINT "approval_process_conditions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_process_conditions" ADD CONSTRAINT "approval_conditions_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."approval_process_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_process_nodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."approval_process_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_process_versions" ADD CONSTRAINT "approval_process_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_process_versions" ADD CONSTRAINT "approval_versions_process_fk" FOREIGN KEY ("tenant_id","process_id") REFERENCES "public"."approval_processes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_process_versions" ADD CONSTRAINT "approval_versions_exception_admin" FOREIGN KEY ("tenant_id","exception_admin_user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_process_versions" ADD CONSTRAINT "approval_versions_creator" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_processes" ADD CONSTRAINT "approval_processes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_processes" ADD CONSTRAINT "approval_processes_creator" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."approval_instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_assignee_fk" FOREIGN KEY ("tenant_id","assignee_user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_ccs_user" ON "approval_instance_ccs" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "approval_ccs_instance" ON "approval_instance_ccs" USING btree ("tenant_id","instance_id");--> statement-breakpoint
CREATE INDEX "approval_logs_admin_self" ON "approval_instance_logs" USING btree ("tenant_id","admin_self_transfer","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_instances_active_business" ON "approval_instances" USING btree ("tenant_id","business_type","business_id") WHERE "approval_instances"."status" IN ('running','returned');--> statement-breakpoint
CREATE INDEX "approval_instances_initiator" ON "approval_instances" USING btree ("tenant_id","initiator_user_id","created_at");--> statement-breakpoint
CREATE INDEX "approval_instances_business" ON "approval_instances" USING btree ("tenant_id","business_type","business_id","created_at");--> statement-breakpoint
CREATE INDEX "approval_notifications_recipient" ON "approval_notifications" USING btree ("tenant_id","recipient_user_id","created_at");--> statement-breakpoint
CREATE INDEX "approval_outbox_cursor" ON "approval_outbox" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_processes_code" ON "approval_processes" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_processes_preset" ON "approval_processes" USING btree ("tenant_id","preset_key") WHERE "approval_processes"."preset_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "approval_processes_type" ON "approval_processes" USING btree ("tenant_id","approval_type","status");--> statement-breakpoint
CREATE INDEX "approval_tasks_assignee" ON "approval_tasks" USING btree ("tenant_id","assignee_user_id","status","created_at");--> statement-breakpoint
ALTER TABLE "personnel_change_requests" ADD CONSTRAINT "personnel_change_requests_state" CHECK ("personnel_change_requests"."status" IN ('pending_approval','applied','withdrawn'));