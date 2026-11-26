ALTER TABLE "onboarding_collection_tasks" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "onboarding_collection_tasks" ADD COLUMN "withdraw_remark" text;
