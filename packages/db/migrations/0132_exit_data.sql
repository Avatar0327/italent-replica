CREATE TABLE "exit_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"state_before" text NOT NULL,
	"cancel_case" text NOT NULL,
	"reason" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"downstream" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"command_id" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exit_cancellations_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "exit_cancellations_business" UNIQUE("tenant_id","business_id"),
	CONSTRAINT "exit_cancellations_state" CHECK ("exit_cancellations"."state_before" IN ('draft', 'in_review', 'approved', 'rejected', 'effective')),
	CONSTRAINT "exit_cancellations_case" CHECK ("exit_cancellations"."cancel_case" IN ('process_voided', 'approved_voided', 'record_deleted', 'record_deleted_reinstated')),
	CONSTRAINT "exit_cancellations_reason" CHECK (btrim("exit_cancellations"."reason") <> ''),
	CONSTRAINT "exit_cancellations_revision" CHECK ("exit_cancellations"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "exit_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"kind" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exit_effects_phase" CHECK ("exit_effects"."phase" IN ('confirmed', 'effective')),
	CONSTRAINT "exit_effects_kind" CHECK ("exit_effects"."kind" IN ('establishment_pre_released', 'contract_terminated', 'contract_deleted',
        'contract_request_withdrawn', 'application_voided', 'future_transfer_detached', 'duty_transferred',
        'duty_failed')),
	CONSTRAINT "exit_effects_target_type" CHECK (btrim("exit_effects"."target_type") <> '')
);
--> statement-breakpoint
CREATE TABLE "exit_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exit_reasons_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "exit_reasons_code_nonempty" CHECK (btrim("exit_reasons"."code") <> ''),
	CONSTRAINT "exit_reasons_name_nonempty" CHECK (btrim("exit_reasons"."name") <> ''),
	CONSTRAINT "exit_reasons_revision_positive" CHECK ("exit_reasons"."revision" > 0),
	CONSTRAINT "exit_reasons_display_order" CHECK ("exit_reasons"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "exit_requests" (
	"tenant_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"initiator" text NOT NULL,
	"initiator_user_id" uuid NOT NULL,
	"attachment_refs" jsonb,
	"process_code" text,
	"exit_type_code" text,
	"reason_code" text,
	"whereabouts_code" text,
	"handover_employee_id" uuid,
	"add_to_blacklist" boolean DEFAULT false NOT NULL,
	"compensation_amount" numeric(14, 2),
	"non_compete_amount" numeric(14, 2),
	"last_pay_date" date,
	"social_insurance_end_month" text,
	"annual_leave_settled" boolean,
	"tax_period" text,
	"tax_year" integer,
	"employer_name" text,
	"actual_leave_date" date,
	"pending_transfer_ack" jsonb,
	"batch_id" uuid,
	"duty_transfer_timing" text NOT NULL,
	"pre_release_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exit_requests_tenant_id_business_id_pk" PRIMARY KEY("tenant_id","business_id"),
	CONSTRAINT "exit_requests_mode" CHECK ("exit_requests"."mode" IN ('application', 'direct')),
	CONSTRAINT "exit_requests_initiator" CHECK ("exit_requests"."initiator" IN ('hr', 'self', 'manager')),
	CONSTRAINT "exit_requests_direct_by_hr" CHECK ("exit_requests"."mode" <> 'direct' OR "exit_requests"."initiator" = 'hr'),
	CONSTRAINT "exit_requests_timing" CHECK ("exit_requests"."duty_transfer_timing" IN ('business_effective', 'approval_passed')),
	CONSTRAINT "exit_requests_attachments" CHECK ("exit_requests"."attachment_refs" IS NULL OR jsonb_typeof("exit_requests"."attachment_refs") = 'array'),
	CONSTRAINT "exit_requests_amounts" CHECK (coalesce("exit_requests"."compensation_amount", 0) >= 0 AND coalesce("exit_requests"."non_compete_amount", 0) >= 0),
	CONSTRAINT "exit_requests_months" CHECK (coalesce("exit_requests"."social_insurance_end_month", '2000-01') ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
        AND coalesce("exit_requests"."tax_period", '2000-01') ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "exit_requests_tax_year" CHECK ("exit_requests"."tax_year" IS NULL OR "exit_requests"."tax_year" BETWEEN 1900 AND 9999)
);
--> statement-breakpoint
CREATE TABLE "exit_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exit_types_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "exit_types_code_nonempty" CHECK (btrim("exit_types"."code") <> ''),
	CONSTRAINT "exit_types_name_nonempty" CHECK (btrim("exit_types"."name") <> ''),
	CONSTRAINT "exit_types_revision_positive" CHECK ("exit_types"."revision" > 0),
	CONSTRAINT "exit_types_display_order" CHECK ("exit_types"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "exit_whereabouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exit_whereabouts_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "exit_whereabouts_code_nonempty" CHECK (btrim("exit_whereabouts"."code") <> ''),
	CONSTRAINT "exit_whereabouts_name_nonempty" CHECK (btrim("exit_whereabouts"."name") <> ''),
	CONSTRAINT "exit_whereabouts_revision_positive" CHECK ("exit_whereabouts"."revision" > 0),
	CONSTRAINT "exit_whereabouts_display_order" CHECK ("exit_whereabouts"."display_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "exit_cancellations" ADD CONSTRAINT "exit_cancellations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_cancellations" ADD CONSTRAINT "exit_cancellations_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_effects" ADD CONSTRAINT "exit_effects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_effects" ADD CONSTRAINT "exit_effects_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_reasons" ADD CONSTRAINT "exit_reasons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_requests" ADD CONSTRAINT "exit_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_requests" ADD CONSTRAINT "exit_requests_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_requests" ADD CONSTRAINT "exit_requests_cycle_fk" FOREIGN KEY ("tenant_id","employee_id","staff_id") REFERENCES "public"."employment_cycles"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_requests" ADD CONSTRAINT "exit_requests_handover_fk" FOREIGN KEY ("tenant_id","handover_employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_types" ADD CONSTRAINT "exit_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_whereabouts" ADD CONSTRAINT "exit_whereabouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exit_cancellations_created" ON "exit_cancellations" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "exit_effects_business" ON "exit_effects" USING btree ("tenant_id","business_id","phase","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "exit_reasons_code" ON "exit_reasons" USING btree ("tenant_id",lower("code"));--> statement-breakpoint
CREATE INDEX "exit_requests_employee" ON "exit_requests" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "exit_requests_batch" ON "exit_requests" USING btree ("tenant_id","batch_id") WHERE "exit_requests"."batch_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "exit_types_code" ON "exit_types" USING btree ("tenant_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "exit_whereabouts_code" ON "exit_whereabouts" USING btree ("tenant_id",lower("code"));--> statement-breakpoint
-- R2-T03 B1a（设计 §2.1 / §2.2 / §2.4）：租户隔离与授权。业务表一律不给 DELETE；可改的列逐列授权，其余列创建后不可改。
SELECT enable_tenant_isolation('exit_requests');
--> statement-breakpoint
-- 扩展行只改非日期业务字段与系统补写字段（流程绑定、令牌集合、编制预减时点）；业务、员工、周期、发起方式、批次、
-- 转交时机快照创建后不变（§2.1 / §4B）
GRANT SELECT, INSERT ON exit_requests TO app_user;
--> statement-breakpoint
GRANT UPDATE (attachment_refs, process_code, exit_type_code, reason_code, whereabouts_code, handover_employee_id,
  add_to_blacklist, compensation_amount, non_compete_amount, last_pay_date, social_insurance_end_month,
  annual_leave_settled, tax_period, tax_year, employer_name, actual_leave_date, pending_transfer_ack, pre_release_date)
  ON exit_requests TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('exit_types');
--> statement-breakpoint
SELECT enable_tenant_isolation('exit_reasons');
--> statement-breakpoint
SELECT enable_tenant_isolation('exit_whereabouts');
--> statement-breakpoint
-- 字典编码保存后不可改、不提供删除（被引用的编码不能消失）
GRANT SELECT, INSERT ON exit_types, exit_reasons, exit_whereabouts TO app_user;
--> statement-breakpoint
GRANT UPDATE (name, enabled, display_order, revision, updated_at) ON exit_types, exit_reasons, exit_whereabouts TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('exit_effects');
--> statement-breakpoint
GRANT SELECT, INSERT ON exit_effects TO app_user;
--> statement-breakpoint
CREATE TRIGGER exit_effects_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON exit_effects FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('exit_cancellations');
--> statement-breakpoint
GRANT SELECT, INSERT ON exit_cancellations TO app_user;
--> statement-breakpoint
-- DM-R5：撤销原因可在「撤销的离职记录」视图事后修改，其余列不可改
GRANT UPDATE (reason, revision) ON exit_cancellations TO app_user;
--> statement-breakpoint
-- DEC-213 职责转交时机，两层配置（租户覆盖走既有 /api/tenant/settings/:key）
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('exit.duty_transfer_timing','"business_effective"'::jsonb,'离职：职责转交时机（business_effective 离职生效时 / approval_passed 审批通过时）',true,1,now());
