CREATE TABLE "offer_dictionary_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_dictionary_items_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "offer_dictionary_items_kind" CHECK ("offer_dictionary_items"."kind" IN ('refusal-reasons', 'invalid-reasons')),
	CONSTRAINT "offer_dictionary_items_code" CHECK (btrim("offer_dictionary_items"."code") <> ''),
	CONSTRAINT "offer_dictionary_items_name" CHECK (btrim("offer_dictionary_items"."name") <> ''),
	CONSTRAINT "offer_dictionary_items_order" CHECK ("offer_dictionary_items"."display_order" >= 0),
	CONSTRAINT "offer_dictionary_items_revision" CHECK ("offer_dictionary_items"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry" text NOT NULL,
	"offer_type" text,
	"source" text DEFAULT 'new_hire' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approval_status" text DEFAULT 'unsubmitted' NOT NULL,
	"name" text,
	"personal_email" text,
	"mobile" text,
	"gender" text,
	"id_type" text,
	"id_number" text,
	"birth_date" date,
	"work_start_date" date,
	"channel_name" text,
	"applied_position" text,
	"recruitment_demand" text,
	"department_id" uuid,
	"planned_entry_date" date,
	"position_id" uuid,
	"post_id" uuid,
	"level_id" uuid,
	"work_place" text,
	"has_probation" boolean,
	"probation_months" integer,
	"direct_manager_id" uuid,
	"dotted_manager_id" uuid,
	"hrbp_id" uuid,
	"cost_center" text,
	"contract_company_id" uuid,
	"contract_term_type" text,
	"contract_months" integer,
	"contract_end_date" date,
	"salary_before_regular" numeric(14, 2),
	"salary_after_regular" numeric(14, 2),
	"social_insurance_base" numeric(14, 2),
	"housing_fund_base" numeric(14, 2),
	"accept_time" date,
	"refusal_time" date,
	"refusal_reason_code" text,
	"refusal_remark" text,
	"invalid_reason_code" text,
	"invalid_remark" text,
	"invalid_at" timestamp with time zone,
	"sent_by" uuid,
	"sent_at" timestamp with time zone,
	"campus_offer_id" uuid,
	"copied_from_offer_id" uuid,
	"pending_entry_business_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offers_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "offers_entry" CHECK ("offers"."entry" IN ('offer', 'intern', 'campus_early_intern')),
	CONSTRAINT "offers_type" CHECK ("offers"."offer_type" IS NULL OR "offers"."offer_type" IN ('social', 'campus', 'intern')),
	CONSTRAINT "offers_source" CHECK ("offers"."source" IN ('new_hire', 'intern_conversion')),
	CONSTRAINT "offers_status_value" CHECK ("offers"."status" IN ('pending', 'sent', 'accepted', 'rejected', 'onboarded', 'invalid')),
	CONSTRAINT "offers_approval_status" CHECK ("offers"."approval_status" IN ('unsubmitted', 'approving', 'approved', 'disapproved')),
	CONSTRAINT "offers_accepted_time" CHECK ("offers"."status" <> 'accepted' OR "offers"."accept_time" IS NOT NULL),
	CONSTRAINT "offers_rejected_form" CHECK ("offers"."status" <> 'rejected' OR ("offers"."refusal_time" IS NOT NULL AND "offers"."refusal_reason_code" IS NOT NULL)),
	CONSTRAINT "offers_invalid_form" CHECK ("offers"."status" <> 'invalid' OR ("offers"."invalid_reason_code" IS NOT NULL AND "offers"."invalid_at" IS NOT NULL)),
	CONSTRAINT "offers_probation_months" CHECK ("offers"."probation_months" IS NULL OR "offers"."probation_months" BETWEEN 0 AND 120),
	CONSTRAINT "offers_contract_months" CHECK ("offers"."contract_months" IS NULL OR "offers"."contract_months" BETWEEN 0 AND 1200),
	CONSTRAINT "offers_revision_positive" CHECK ("offers"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "offer_dictionary_items" ADD CONSTRAINT "offer_dictionary_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_post_fk" FOREIGN KEY ("tenant_id","post_id") REFERENCES "public"."job_post_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."job_level_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_directManagerId_fk" FOREIGN KEY ("tenant_id","direct_manager_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_dottedManagerId_fk" FOREIGN KEY ("tenant_id","dotted_manager_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_hrbpId_fk" FOREIGN KEY ("tenant_id","hrbp_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_contract_company_fk" FOREIGN KEY ("tenant_id","contract_company_id") REFERENCES "public"."contract_companies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_campus_offer_fk" FOREIGN KEY ("tenant_id","campus_offer_id") REFERENCES "public"."offers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_copied_from_fk" FOREIGN KEY ("tenant_id","copied_from_offer_id") REFERENCES "public"."offers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_pending_entry_fk" FOREIGN KEY ("tenant_id","pending_entry_business_id") REFERENCES "public"."employment_business_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offer_dictionary_items_code_unique" ON "offer_dictionary_items" USING btree ("tenant_id","kind",lower("code"));--> statement-breakpoint
CREATE INDEX "offers_status" ON "offers" USING btree ("tenant_id","status","approval_status","created_at");--> statement-breakpoint
SELECT enable_tenant_isolation('offers');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON offers TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('offer_dictionary_items');
--> statement-breakpoint
GRANT SELECT, INSERT ON offer_dictionary_items TO app_user;
--> statement-breakpoint
GRANT UPDATE (name, enabled, display_order, revision, updated_at) ON offer_dictionary_items TO app_user;
--> statement-breakpoint
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('offer.send_requires_approval','{"social":false,"campus":false,"intern":false}'::jsonb,'Offer：按类型设置发送前须审批通过（OF-R3）',true,1,now());
