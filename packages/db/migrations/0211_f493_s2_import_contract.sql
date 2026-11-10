CREATE TABLE "exit_import_batches" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"command_id" text NOT NULL,
	"submitted_by" uuid NOT NULL,
	"file_name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"error_row_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "exit_import_batches_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "exit_import_batches_status" CHECK ("exit_import_batches"."status" IN ('queued','running','completed','failed')),
	CONSTRAINT "exit_import_batches_total" CHECK ("exit_import_batches"."total" BETWEEN 1 AND 1000),
	CONSTRAINT "exit_import_batches_counts" CHECK ("exit_import_batches"."created_count" >= 0 AND "exit_import_batches"."error_row_count" >= 0 AND "exit_import_batches"."error_count" >= 0 AND "exit_import_batches"."attempts" >= 0
        AND "exit_import_batches"."error_row_count" <= "exit_import_batches"."total" AND "exit_import_batches"."error_count" >= "exit_import_batches"."error_row_count"),
	CONSTRAINT "exit_import_batches_file_name" CHECK (char_length("exit_import_batches"."file_name") BETWEEN 1 AND 255),
	CONSTRAINT "exit_import_batches_expires" CHECK ("exit_import_batches"."expires_at" IS NULL OR "exit_import_batches"."status" IN ('completed','failed'))
);
--> statement-breakpoint
CREATE TABLE "exit_import_rows" (
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"name" text,
	"email" text,
	"department_code" text,
	"entry_date" text,
	"position_name" text,
	"post_name" text,
	"level_name" text,
	"work_date" text,
	"place" text,
	"id_number" text,
	"mobile_phone" text,
	"personal_email" text,
	"gender" text,
	"birthday" text,
	"nation" text,
	"political_status" text,
	"household_address" text,
	"regist_address" text,
	"school" text,
	"major" text,
	"last_work_date" text,
	"exit_type_name" text,
	"exit_reason_name" text,
	"whereabouts_name" text,
	"exit_note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"employee_id" uuid,
	"exit_business_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exit_import_rows_tenant_id_batch_id_row_no_pk" PRIMARY KEY("tenant_id","batch_id","row_no"),
	CONSTRAINT "exit_import_rows_row_no" CHECK ("exit_import_rows"."row_no" >= 1),
	CONSTRAINT "exit_import_rows_status" CHECK ("exit_import_rows"."status" IN ('pending','succeeded','created_with_error','failed')),
	CONSTRAINT "exit_import_rows_errors" CHECK (jsonb_typeof("exit_import_rows"."errors") = 'array' AND (("exit_import_rows"."status" IN ('failed','created_with_error'))
        = (jsonb_array_length("exit_import_rows"."errors") > 0))),
	CONSTRAINT "exit_import_rows_refs" CHECK (("exit_import_rows"."status" IN ('succeeded','created_with_error')) = ("exit_import_rows"."employee_id" IS NOT NULL)
        AND ("exit_import_rows"."employee_id" IS NOT NULL) = ("exit_import_rows"."exit_business_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "exit_import_batches" ADD CONSTRAINT "exit_import_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_import_batches" ADD CONSTRAINT "exit_import_batches_submitter_fk" FOREIGN KEY ("tenant_id","submitted_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_import_rows" ADD CONSTRAINT "exit_import_rows_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."exit_import_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_import_rows" ADD CONSTRAINT "exit_import_rows_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_import_rows" ADD CONSTRAINT "exit_import_rows_business_fk" FOREIGN KEY ("tenant_id","employee_id","exit_business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exit_import_batches_status_lease" ON "exit_import_batches" USING btree ("tenant_id","status","lease_until");--> statement-breakpoint
CREATE INDEX "exit_import_batches_expiry" ON "exit_import_batches" USING btree ("tenant_id","expires_at") WHERE "exit_import_batches"."purged_at" IS NULL;--> statement-breakpoint
CREATE INDEX "exit_import_batches_own_list" ON "exit_import_batches" USING btree ("tenant_id","submitted_by","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "exit_import_rows_pending" ON "exit_import_rows" USING btree ("tenant_id","batch_id","status","row_no");
--> statement-breakpoint
-- F-493 S2：两张导入表按租户隔离（FORCE RLS），应用角色只授 SELECT / INSERT / UPDATE：
-- 过期清理是把原始值置 NULL（设计 §8.3），不删行，导入历史要保留批次与计数。
ALTER TABLE exit_import_batches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE exit_import_batches FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON exit_import_batches USING (tenant_id=current_tenant_id())
  WITH CHECK (tenant_id=current_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON exit_import_batches TO app_user;
--> statement-breakpoint
ALTER TABLE exit_import_rows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE exit_import_rows FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON exit_import_rows USING (tenant_id=current_tenant_id())
  WITH CHECK (tenant_id=current_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON exit_import_rows TO app_user;
--> statement-breakpoint
-- 导入专用开通函数（设计 §4.5）：每个建了人的行建一个停用账号。联系邮箱已被某账号占用时（b 类冲突）新账号无登录名；
-- 否则分配由账号 ID 推出的虚拟登录名。登录名的判定与插入在同一函数里，应用层既不拼也不传，
-- 应用角色仍不能直接 INSERT INTO users。不返回任何已有账号的信息。
CREATE FUNCTION tenant_provision_import_account(p_contact_email text, p_display_name text, p_actor uuid,
  p_command_id text)
  RETURNS TABLE (account_id uuid, login_assigned boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_login text;
  v_name text := btrim(coalesce(p_display_name, ''));
BEGIN
  IF current_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'tenant_provision_import_account 只能在租户上下文中调用' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 联系邮箱必须已由调用方规范化：不一致就拒绝，防止绕过规范化后撞登录名
  IF p_contact_email IS NULL OR p_contact_email = '' OR p_contact_email <> lower(btrim(p_contact_email))
    OR v_name = '' THEN
    RAISE EXCEPTION '联系邮箱未规范化或姓名为空' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE email = p_contact_email) THEN
    v_login := 'va-' || replace(v_id::text, '-', '') || '@virtualaccount.invalid';
  END IF;
  INSERT INTO users (id, email, display_name, status) VALUES (v_id, v_login, v_name, 'disabled');
  INSERT INTO platform_audit_events (actor_user_id, action, object_type, object_id, before, after, command_id)
  VALUES (p_actor, 'user.create', 'user', v_id::text, NULL,
    jsonb_build_object('email', v_login, 'displayName', v_name, 'status', 'disabled', 'revision', 1,
      'source', 'exit_import', 'loginAssigned', v_login IS NOT NULL),
    p_command_id);
  RETURN QUERY SELECT v_id, v_login IS NOT NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION tenant_provision_import_account(text, text, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenant_provision_import_account(text, text, uuid, text) TO app_user;
