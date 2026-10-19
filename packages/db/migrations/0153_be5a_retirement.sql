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
