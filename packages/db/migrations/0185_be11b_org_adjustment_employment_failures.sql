CREATE TABLE "org_adjustment_employment_failures" (
	"tenant_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_adjustment_employment_failures_tenant_id_item_id_employee_id_pk" PRIMARY KEY("tenant_id","item_id","employee_id")
);
--> statement-breakpoint
ALTER TABLE "org_adjustment_employment_failures" ADD CONSTRAINT "org_adjustment_employment_failures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_employment_failures" ADD CONSTRAINT "org_adjustment_employment_failures_adjustment_fk" FOREIGN KEY ("tenant_id","adjustment_id") REFERENCES "public"."org_adjustments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_adjustment_employment_failures_adjustment" ON "org_adjustment_employment_failures" USING btree ("tenant_id","adjustment_id");--> statement-breakpoint
-- R2-T08 §7.5：逐员工失败表同租户隔离（硬规则 7），执行器在 withTenant 内写入。
SELECT enable_tenant_isolation('org_adjustment_employment_failures');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON org_adjustment_employment_failures TO app_user;
