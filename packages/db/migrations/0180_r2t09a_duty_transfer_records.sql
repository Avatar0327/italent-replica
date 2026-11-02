CREATE TABLE "duty_transfer_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"receiver_id" uuid NOT NULL,
	"duty_type" smallint NOT NULL,
	"org_id" uuid,
	"org_role" text,
	"subordinate_id" uuid,
	"relation" text,
	"duty_details" text NOT NULL,
	"status" smallint NOT NULL,
	"transfer_date" date NOT NULL,
	"transfer_at" timestamp with time zone,
	"batch_id" uuid NOT NULL,
	"source" smallint DEFAULT 1 NOT NULL,
	"operator_id" uuid NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"failure_rule" text,
	"last_attempt_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "duty_transfer_records_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "duty_transfer_records_status" CHECK ("duty_transfer_records"."status" IN (0, 1, 2, 3)),
	CONSTRAINT "duty_transfer_records_source" CHECK ("duty_transfer_records"."source" = 1),
	CONSTRAINT "duty_transfer_records_target" CHECK (("duty_transfer_records"."duty_type" = 1 AND "duty_transfer_records"."org_id" IS NOT NULL AND "duty_transfer_records"."org_role" IN ('person_in_charge', 'shop_owner', 'hrbp')
        AND "duty_transfer_records"."subordinate_id" IS NULL AND "duty_transfer_records"."relation" IS NULL)
      OR ("duty_transfer_records"."duty_type" = 2 AND "duty_transfer_records"."subordinate_id" IS NOT NULL AND "duty_transfer_records"."relation" IN ('direct', 'dotted')
        AND "duty_transfer_records"."org_id" IS NULL AND "duty_transfer_records"."org_role" IS NULL)),
	CONSTRAINT "duty_transfer_records_completed" CHECK (("duty_transfer_records"."status" = 1) = ("duty_transfer_records"."transfer_at" IS NOT NULL)),
	CONSTRAINT "duty_transfer_records_counts" CHECK ("duty_transfer_records"."attempt_count" >= 0 AND "duty_transfer_records"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "duty_transfer_records" ADD CONSTRAINT "duty_transfer_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_transfer_records" ADD CONSTRAINT "duty_transfer_records_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_transfer_records" ADD CONSTRAINT "duty_transfer_records_receiver_fk" FOREIGN KEY ("tenant_id","receiver_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_transfer_records" ADD CONSTRAINT "duty_transfer_records_subordinate_fk" FOREIGN KEY ("tenant_id","subordinate_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_transfer_records" ADD CONSTRAINT "duty_transfer_records_org_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_transfer_records" ADD CONSTRAINT "duty_transfer_records_operator_fk" FOREIGN KEY ("tenant_id","operator_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "duty_transfer_records_one_pending" ON "duty_transfer_records" USING btree ("tenant_id","employee_id",COALESCE("org_id", "subordinate_id"),COALESCE("org_role", "relation")) WHERE "duty_transfer_records"."status" = 0;--> statement-breakpoint
CREATE INDEX "duty_transfer_records_due" ON "duty_transfer_records" USING btree ("tenant_id","status","transfer_date");--> statement-breakpoint
CREATE INDEX "duty_transfer_records_employee" ON "duty_transfer_records" USING btree ("tenant_id","employee_id","created_at");--> statement-breakpoint
-- R2-T09a：菜单转交记录同租户隔离（硬规则 7）；离职 / 调动内转交仍在 transfer_linkage_items，不迁移旧数据。
SELECT enable_tenant_isolation('duty_transfer_records');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON duty_transfer_records TO app_user;
--> statement-breakpoint
-- R2-T09a 第 2 轮：菜单转交下属写入异动类型“数据调整”（`30` DT-R7 / AC-DT-04）。
ALTER TABLE "employment_payload_versions" DROP CONSTRAINT "employment_payload_versions_change_type";--> statement-breakpoint
ALTER TABLE "employment_records" DROP CONSTRAINT "employment_records_change_type";--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_change_type" CHECK ("employment_payload_versions"."change_type" IN ('position_adjustment', 'intern_regularization', 'intern_end', 'org_adjustment', 'data_adjustment'));--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_change_type" CHECK ("employment_records"."change_type" IN ('position_adjustment', 'intern_regularization', 'intern_end', 'org_adjustment', 'data_adjustment'));
