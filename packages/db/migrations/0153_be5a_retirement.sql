CREATE TABLE "retirement_requests" (
	"tenant_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"expected_retirement_date" date,
	"retire_type" text,
	"re_employed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retirement_requests_tenant_id_business_id_pk" PRIMARY KEY("tenant_id","business_id"),
	CONSTRAINT "retirement_requests_type" CHECK ("retirement_requests"."retire_type" IS NULL OR "retirement_requests"."retire_type" IN ('early', 'normal', 'delayed')),
	CONSTRAINT "retirement_requests_type_needs_expected" CHECK ("retirement_requests"."retire_type" IS NULL OR "retirement_requests"."expected_retirement_date" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "retirement_requests" ADD CONSTRAINT "retirement_requests_exit_fk" FOREIGN KEY ("tenant_id","business_id") REFERENCES "public"."exit_requests"("tenant_id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retirement_requests_employee" ON "retirement_requests" USING btree ("tenant_id","employee_id");--> statement-breakpoint
-- R2-T04 BE-5a（设计 §2.2）：租户隔离与授权。业务表不给 DELETE；创建后只有退休类型可由系统顺延重派生（§3.5 / §4.3），
-- 快照 P、员工、是否返聘创建后不变。
SELECT enable_tenant_isolation('retirement_requests');
--> statement-breakpoint
GRANT SELECT, INSERT ON retirement_requests TO app_user;
--> statement-breakpoint
GRANT UPDATE (retire_type) ON retirement_requests TO app_user;

--> statement-breakpoint
-- R2-T04 BE-5a（设计 §4.1 / 审查 P2-2）：退休与离职同为终止业务，退休落地时同样摘下同周期、排在它之后的已落地调动。
-- 0147 的 employment_record_detached 只接受 leave_record.kind='leave'，已有未来直接调动时办理退休会在覆盖校验触发器上 23514。
-- 这里只把来源放宽到 leave / retirement；其余条件（同租户、同员工、同任职周期、有离职扩展行、记录仍在时间轴上、
-- 按可信顺序 employment_follows 严格排在其后、目标是主职调动且当前没有投影）一条都不放松。0147 旧迁移不改。
CREATE OR REPLACE FUNCTION employment_record_detached(p_tenant uuid, p_record uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employment_records r
    JOIN public.exit_effects x ON x.tenant_id = r.tenant_id AND x.employee_id = r.employee_id
      AND x.kind = 'future_transfer_detached' AND x.phase = 'effective'
      AND x.target_type = 'employment-record' AND x.target_id = r.id
    JOIN public.employment_records leave_record ON leave_record.tenant_id = x.tenant_id
      AND leave_record.id = x.business_id AND leave_record.employee_id = r.employee_id
      AND leave_record.staff_id = r.staff_id AND leave_record.kind IN ('leave', 'retirement')
    JOIN public.employment_timeline leave_row ON leave_row.tenant_id = leave_record.tenant_id
      AND leave_row.record_id = leave_record.id
    JOIN public.exit_requests source_exit ON source_exit.tenant_id = leave_record.tenant_id
      AND source_exit.business_id = leave_record.id
    WHERE r.tenant_id = p_tenant AND r.id = p_record AND r.kind = 'transfer' AND r.service_type = 'primary'
      AND public.employment_follows(r.tenant_id, leave_record.id, r.id)
      AND NOT EXISTS (SELECT 1 FROM public.employment_timeline own
        WHERE own.tenant_id = r.tenant_id AND own.record_id = r.id)
  );
$$;
