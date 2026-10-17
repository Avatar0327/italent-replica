ALTER TABLE "employment_payload_versions" DROP CONSTRAINT "employment_payload_versions_change_type";--> statement-breakpoint
ALTER TABLE "employment_records" DROP CONSTRAINT "employment_records_change_type";--> statement-breakpoint
ALTER TABLE "employment_probation_versions" DROP CONSTRAINT "employment_probation_versions_source";--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_change_type" CHECK ("employment_payload_versions"."change_type" IN ('position_adjustment', 'intern_regularization'));--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_change_type" CHECK ("employment_records"."change_type" IN ('position_adjustment', 'intern_regularization'));--> statement-breakpoint
ALTER TABLE "employment_probation_versions" ADD CONSTRAINT "employment_probation_versions_source" CHECK ("employment_probation_versions"."source" IN ('entry', 'adjust', 'intern_regularization'));