ALTER TABLE "approval_instances" ADD COLUMN "approval_category" text;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD COLUMN "business_date" date;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_category" CHECK ("approval_instances"."approval_category" IS NULL OR "approval_instances"."approval_category" IN ('offer','entry','regularization','transfer','exit',
        'contract','other'));