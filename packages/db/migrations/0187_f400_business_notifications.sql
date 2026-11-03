ALTER TABLE "approval_notifications" ALTER COLUMN "instance_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_notifications" ADD COLUMN "business_type" text;--> statement-breakpoint
ALTER TABLE "approval_notifications" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_notifications" ADD CONSTRAINT "approval_notifications_target" CHECK ("approval_notifications"."instance_id" IS NOT NULL OR ("approval_notifications"."business_type" IS NOT NULL AND "approval_notifications"."business_id" IS NOT NULL));