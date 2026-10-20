CREATE TABLE "exit_handover_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category" text NOT NULL,
	"sequence_no" integer NOT NULL,
	"todo_type" text NOT NULL,
	"title" text NOT NULL,
	"form_ref" text,
	"remark" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exit_handover_items_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "exit_handover_items_category" CHECK (btrim("exit_handover_items"."category") <> '' AND char_length("exit_handover_items"."category") <= 50),
	CONSTRAINT "exit_handover_items_sequence" CHECK ("exit_handover_items"."sequence_no" >= 1),
	CONSTRAINT "exit_handover_items_todo_type" CHECK ("exit_handover_items"."todo_type" IN ('work_handover', 'other')),
	CONSTRAINT "exit_handover_items_title" CHECK (btrim("exit_handover_items"."title") <> '' AND char_length("exit_handover_items"."title") <= 200),
	CONSTRAINT "exit_handover_items_form" CHECK ("exit_handover_items"."form_ref" IS NULL OR char_length("exit_handover_items"."form_ref") <= 200),
	CONSTRAINT "exit_handover_items_remark" CHECK ("exit_handover_items"."remark" IS NULL OR char_length("exit_handover_items"."remark") <= 500),
	CONSTRAINT "exit_handover_items_revision_positive" CHECK ("exit_handover_items"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "exit_requests" ADD COLUMN "blacklist_expiry_date" date;--> statement-breakpoint
ALTER TABLE "exit_requests" ADD COLUMN "blacklist_reason" text;--> statement-breakpoint
ALTER TABLE "exit_requests" ADD COLUMN "blacklist_note" text;--> statement-breakpoint
ALTER TABLE "employment_blacklist" ADD COLUMN "exit_request_id" uuid;--> statement-breakpoint
ALTER TABLE "exit_handover_items" ADD CONSTRAINT "exit_handover_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exit_handover_items_list" ON "exit_handover_items" USING btree ("tenant_id","sequence_no","created_at","id");--> statement-breakpoint
ALTER TABLE "employment_blacklist" ADD CONSTRAINT "employment_blacklist_exit_fk" FOREIGN KEY ("tenant_id","exit_request_id") REFERENCES "public"."exit_requests"("tenant_id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employment_blacklist_exit_request" ON "employment_blacklist" USING btree ("tenant_id","exit_request_id") WHERE "employment_blacklist"."exit_request_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "exit_requests" ADD CONSTRAINT "exit_requests_blacklist" CHECK (("exit_requests"."add_to_blacklist" OR ("exit_requests"."blacklist_expiry_date" IS NULL AND "exit_requests"."blacklist_reason" IS NULL
          AND "exit_requests"."blacklist_note" IS NULL))
        AND ("exit_requests"."blacklist_reason" IS NULL
          OR "exit_requests"."blacklist_reason" IN ('major_violation', 'integrity', 'instability', 'resignation', 'other'))
        AND coalesce(char_length("exit_requests"."blacklist_note"), 0) <= 500);--> statement-breakpoint
-- R2 BE-8b1（B64 B65 B68）：加黑三项与 add_to_blacklist 同属“非日期业务字段”，创建后到生效前可随离职编辑；
-- 黑名单的 exit_request_id 随 INSERT 写入，之后不改（撤销离职时只据它认行，移出走既有状态列授权）
GRANT UPDATE (blacklist_expiry_date, blacklist_reason, blacklist_note) ON exit_requests TO app_user;
--> statement-breakpoint
-- 离职交接事项设置：配置对象，租户隔离；整行可删（事项只是设置，不被其他表引用，交接执行归 BE-8b2）
SELECT enable_tenant_isolation('exit_handover_items');
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON exit_handover_items TO app_user;
--> statement-breakpoint
GRANT UPDATE (category, sequence_no, todo_type, title, form_ref, remark, revision, updated_at)
  ON exit_handover_items TO app_user;
--> statement-breakpoint
-- 交接发起规则（DEC-266③、DEC-632）：两层配置（租户覆盖走既有 /api/tenant/settings/:key），系统值照原站现状
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('exit.handover_trigger',
   '{"enabled":true,"method":"on_approval_passed","includePastLastWorkDate":true,"initiator":"self","remind":{"enabled":true,"daysBeforeLastWorkDate":5,"daysAfterLastWorkDate":15}}'::jsonb,
   '离职：交接发起规则（method 只接受 on_approval_passed 审批通过后自动发起；initiator 只接受 self 员工本人）',
   true,1,now());
