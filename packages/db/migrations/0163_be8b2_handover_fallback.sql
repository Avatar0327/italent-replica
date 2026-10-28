ALTER TABLE "exit_handover_requests" DROP CONSTRAINT "exit_handover_requests_state";--> statement-breakpoint
DROP INDEX "exit_handover_requests_live";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "fallback_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "exit_handover_requests" ADD COLUMN "not_launched_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "exit_handover_requests_live" ON "exit_handover_requests" USING btree ("tenant_id","exit_request_id") WHERE "exit_handover_requests"."state" IN ('in_progress', 'completed', 'not_launched');--> statement-breakpoint
ALTER TABLE "exit_handover_requests" ADD CONSTRAINT "exit_handover_requests_not_launched" CHECK (("exit_handover_requests"."state" = 'not_launched') = ("exit_handover_requests"."not_launched_reason" IS NOT NULL)
        AND coalesce("exit_handover_requests"."not_launched_reason", 'NO_HANDLER') IN ('NO_HANDLER'));--> statement-breakpoint
ALTER TABLE "exit_handover_requests" ADD CONSTRAINT "exit_handover_requests_state" CHECK ("exit_handover_requests"."state" IN ('in_progress', 'completed', 'terminated', 'not_launched'));--> statement-breakpoint
-- R2 BE-8b2 DEC-663：交接未发起（not_launched）记录转已终止时要清掉未发起原因
GRANT UPDATE (not_launched_reason) ON exit_handover_requests TO app_user;
