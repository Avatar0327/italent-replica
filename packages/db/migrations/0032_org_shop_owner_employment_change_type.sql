ALTER TABLE "org_versions" ADD COLUMN "shop_owner_id" uuid;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD COLUMN "change_type" text;--> statement-breakpoint
ALTER TABLE "employment_records" ADD COLUMN "change_type" text;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_change_type" CHECK ("employment_payload_versions"."change_type" IN ('position_adjustment'));--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_change_type" CHECK ("employment_records"."change_type" IN ('position_adjustment'));