ALTER TABLE "exit_handover_requests" DROP CONSTRAINT "exit_handover_requests_not_launched";--> statement-breakpoint
ALTER TABLE "exit_handover_requests" ALTER COLUMN "initiator_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "exit_handover_requests" ADD CONSTRAINT "exit_handover_requests_initiator" CHECK ("exit_handover_requests"."state" NOT IN ('in_progress', 'completed') OR "exit_handover_requests"."initiator_user_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "exit_handover_requests" ADD CONSTRAINT "exit_handover_requests_not_launched" CHECK (("exit_handover_requests"."state" = 'not_launched') = ("exit_handover_requests"."not_launched_reason" IS NOT NULL)
        AND coalesce("exit_handover_requests"."not_launched_reason", 'NO_HANDLER')
          IN ('NO_HANDLER', 'APPROVAL_PROCESS_NOT_MATCHED', 'NO_INITIATOR_ACCOUNT'));--> statement-breakpoint
-- DEC-674：未发起首次启动时补员工账号与部门；已终止重提可按当前可用账号发起，原审批实例不改写。
GRANT UPDATE (initiator_user_id, department_id) ON exit_handover_requests TO app_user;
