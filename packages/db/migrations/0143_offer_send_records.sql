CREATE TABLE "offer_send_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"recipient" text NOT NULL,
	"cc" text[] DEFAULT '{}' NOT NULL,
	"bcc" text[] DEFAULT '{}' NOT NULL,
	"sent_by" uuid NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_send_records_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "offer_send_records_kind" CHECK ("offer_send_records"."kind" IN ('send', 'resend')),
	CONSTRAINT "offer_send_records_status" CHECK ("offer_send_records"."status" IN ('pending', 'sent', 'failed', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "offer_send_records" ADD CONSTRAINT "offer_send_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_send_records" ADD CONSTRAINT "offer_send_records_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."offers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_send_records_offer" ON "offer_send_records" USING btree ("tenant_id","offer_id","created_at");--> statement-breakpoint
SELECT enable_tenant_isolation('offer_send_records');
--> statement-breakpoint
GRANT SELECT, INSERT ON offer_send_records TO app_user;
--> statement-breakpoint
-- OF-R3 / OF-R4：必审字段按 Offer 类型设置（只能是非必填字段），出厂都为空；仅在该类型开了“发送前须审批”时起作用
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('offer.review_fields','{"social":[],"campus":[],"intern":[]}'::jsonb,'Offer：必审字段（按类型：social 社招 / campus 校招 / intern 实习；审批通过后修改须再审）',true,1,now());
