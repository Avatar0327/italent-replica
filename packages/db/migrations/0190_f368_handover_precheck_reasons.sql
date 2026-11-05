ALTER TABLE "exit_handover_requests" DROP CONSTRAINT "exit_handover_requests_not_launched";--> statement-breakpoint
ALTER TABLE "exit_handover_requests" ADD CONSTRAINT "exit_handover_requests_not_launched" CHECK (("exit_handover_requests"."state" = 'not_launched') = ("exit_handover_requests"."not_launched_reason" IS NOT NULL)
        AND coalesce("exit_handover_requests"."not_launched_reason", 'NO_HANDLER')
          IN ('NO_HANDLER', 'APPROVAL_PROCESS_NOT_MATCHED', 'NO_INITIATOR_ACCOUNT',
            'APPROVAL_EXCEPTION_ADMIN_SELF', 'APPROVAL_EXCEPTION_ADMIN_UNAVAILABLE'));