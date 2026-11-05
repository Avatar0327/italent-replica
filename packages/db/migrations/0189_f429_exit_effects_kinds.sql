ALTER TABLE "exit_effects" DROP CONSTRAINT "exit_effects_kind";--> statement-breakpoint
ALTER TABLE "exit_effects" ADD CONSTRAINT "exit_effects_kind" CHECK ("exit_effects"."kind" IN ('establishment_pre_released', 'contract_terminated', 'contract_deleted',
        'contract_request_withdrawn', 'application_voided', 'future_transfer_detached', 'duty_transferred',
        'duty_failed', 'rehire_created', 'assessment_voided', 'part_time_ended', 'part_time_request_voided'));