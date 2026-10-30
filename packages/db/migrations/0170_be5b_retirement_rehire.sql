ALTER TABLE "exit_effects" DROP CONSTRAINT "exit_effects_kind";--> statement-breakpoint
ALTER TABLE "retirement_requests" ADD COLUMN "rehire_plan" jsonb;--> statement-breakpoint
ALTER TABLE "retirement_requests" ADD COLUMN "rehire_business_id" uuid;--> statement-breakpoint
ALTER TABLE "retirement_requests" ADD CONSTRAINT "retirement_requests_rehire_fk" FOREIGN KEY ("tenant_id","rehire_business_id") REFERENCES "public"."employment_business_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_effects" ADD CONSTRAINT "exit_effects_kind" CHECK ("exit_effects"."kind" IN ('establishment_pre_released', 'contract_terminated', 'contract_deleted',
        'contract_request_withdrawn', 'application_voided', 'future_transfer_detached', 'duty_transferred',
        'duty_failed', 'rehire_created'));--> statement-breakpoint
ALTER TABLE "retirement_requests" ADD CONSTRAINT "retirement_requests_rehire_plan" CHECK ("retirement_requests"."re_employed" = ("retirement_requests"."rehire_plan" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "retirement_requests" ADD CONSTRAINT "retirement_requests_rehire_business" CHECK ("retirement_requests"."rehire_business_id" IS NULL OR "retirement_requests"."re_employed");
--> statement-breakpoint
-- R2-T04 BE-5b（设计 §2.2）：返聘计划与 re_employed 创建后不变；生效时只回写生成的返聘业务（rehire_business_id，一次性：
-- 其后撤销返聘也不清空，撤销退休的守卫按业务最新状态判断是否已删除）。业务表仍不给 DELETE。
GRANT UPDATE (rehire_business_id) ON retirement_requests TO app_user;
