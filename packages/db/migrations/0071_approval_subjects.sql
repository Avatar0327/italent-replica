CREATE TABLE "approval_instance_subjects" (
	"tenant_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"employee_id" uuid NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_instance_subjects_tenant_id_instance_id_round_employee_id_pk" PRIMARY KEY("tenant_id","instance_id","round","employee_id"),
	CONSTRAINT "approval_instance_subjects_round" CHECK ("approval_instance_subjects"."round" > 0)
);
--> statement-breakpoint
ALTER TABLE "approval_tasks" DROP CONSTRAINT "approval_tasks_origin";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ALTER COLUMN "avoid_self" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "avoid_subjects" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "avoid_subjects_result" text DEFAULT 'skip' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_instance_subjects" ADD CONSTRAINT "approval_instance_subjects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instance_subjects" ADD CONSTRAINT "approval_instance_subjects_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."approval_instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_instance_subjects_user" ON "approval_instance_subjects" USING btree ("tenant_id","instance_id","user_id");--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_avoid_subjects_result" CHECK ("approval_process_nodes"."avoid_subjects_result" IN ('skip'));--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_origin" CHECK ("approval_tasks"."origin" IN ('resolved','self_skip','self_skip_manager','exception_admin','same_skip',
        'history_skip','no_assignee_skip','no_assignee_approve','transfer','add_sign','admin_transfer',
        'admin_intervene','blind_review','handover','add_sign_before','add_sign_after','add_sign_return','retrieve',
        'add_sign_parallel','countersign_reopen','subject_skip'));--> statement-breakpoint
-- F-048（设计 §5.1）：主体冻结集合强制租户隔离；只追加，发起与重提写入新一轮，连接角色也不得改写或删除。
SELECT enable_tenant_isolation('approval_instance_subjects');
--> statement-breakpoint
GRANT SELECT, INSERT ON "approval_instance_subjects" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "approval_instance_subjects_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "approval_instance_subjects" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
