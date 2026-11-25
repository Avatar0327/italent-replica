ALTER TABLE "onboarding_collection_tasks" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "onboarding_collection_tasks" ADD COLUMN "withdraw_remark" text;--> statement-breakpoint
-- 撤回把曾提交值从普通读投影撤下：只放开 values 一列的 UPDATE（设计 §4.1 第 7 条，16a-2c）
GRANT UPDATE ("values") ON onboarding_collection_submissions TO app_user;
