ALTER TABLE "employment_pending_entry_contract" ADD COLUMN "contract_company_id" uuid;--> statement-breakpoint
ALTER TABLE "employment_pending_entry_probation" ADD COLUMN "months" integer;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "sync_status" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "sync_target" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "sync_reason" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "sync_message" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "sync_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "last_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "linked_employee_id" uuid;--> statement-breakpoint
ALTER TABLE "employment_pending_entry_contract" ADD CONSTRAINT "employment_pending_entry_contract_company_fk" FOREIGN KEY ("tenant_id","contract_company_id") REFERENCES "public"."contract_companies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_linkedEmployeeId_fk" FOREIGN KEY ("tenant_id","linked_employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_sync_target" CHECK ("offers"."sync_target" IS NULL OR "offers"."sync_target" IN ('pending_entry', 'intern_regularization'));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_sync_status" CHECK ("offers"."sync_status" IS NULL OR "offers"."sync_status" IN ('success', 'failed'));
--> statement-breakpoint
-- R2 BE-14b2：OF-R8 同步待入职时机（docs/02_业务建模/34 OF-R8）。两层配置（系统预置 + 租户覆盖），取值校验在 domain offer/sync.ts 登记。
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('offer.sync_timing','{"enabled":true,"mode":"on_accept","days":30,"internConversion":true}'::jsonb,'Offer：同步待入职时机（enabled 开关；mode：on_send 发送时 / on_accept 接受时 / on_accept_within_days 接受且距入职日 ≤ days 天，夜间补同步；internConversion：在职实习生的正式 Offer 是否同步）',true,1,now());
