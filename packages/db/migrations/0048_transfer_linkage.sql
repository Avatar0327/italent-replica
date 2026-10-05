ALTER TABLE "employment_payload_versions" ADD COLUMN "is_store_manager" boolean;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD COLUMN "added_subordinate_ids" uuid[];--> statement-breakpoint
ALTER TABLE "employment_records" ADD COLUMN "is_store_manager" boolean;--> statement-breakpoint
ALTER TABLE "employment_records" ADD COLUMN "added_subordinate_ids" uuid[];