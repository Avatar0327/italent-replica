CREATE TABLE "employment_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" integer,
	"display_order" integer DEFAULT 0 NOT NULL,
	"effective_date" date NOT NULL,
	"expiry_date" date NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"remark" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_forms_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_forms_tenant_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "employment_forms_category" CHECK ("employment_forms"."category" IN (1,2,3,4)),
	CONSTRAINT "employment_forms_nonempty" CHECK (btrim("employment_forms"."code") <> '' AND btrim("employment_forms"."name") <> ''),
	CONSTRAINT "employment_forms_dates" CHECK ("employment_forms"."effective_date" <= "employment_forms"."expiry_date"),
	CONSTRAINT "employment_forms_revision_order" CHECK ("employment_forms"."revision" > 0 AND "employment_forms"."display_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "employment_forms" ADD CONSTRAINT "employment_forms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- F-321 / DEC-402：原文本精确匹配名称，未知置空；逐租户执行以支持 FORCE RLS 的 app_owner。
SELECT enable_tenant_isolation('employment_forms');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON employment_forms TO app_user;
--> statement-breakpoint
ALTER TABLE employment_payload_versions DISABLE TRIGGER employment_payload_versions_append_only;
--> statement-breakpoint
ALTER TABLE employment_records DISABLE TRIGGER employment_records_append_only;
--> statement-breakpoint
ALTER TABLE part_time_request_versions DISABLE TRIGGER part_time_request_versions_append_only;
--> statement-breakpoint
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    INSERT INTO employment_forms(tenant_id,code,name,category,display_order,effective_date,expiry_date,enabled)
    SELECT t.id, p.code, p.name, p.category, p.display_order, p.effective_date::date, '9999-12-31'::date, true
    FROM (VALUES
      ('third_party', '第三方员工', 2, 0, '2025-01-01'),
      ('regular', '正式员工', 1, 0, '2023-11-20'),
      ('temporary', '临时工', 2, 0, '2024-08-09'),
      ('intern', '实习生', 3, 0, '2023-11-20'),
      ('outsourced', '外包人员', 4, 0, '2023-11-20'),
      ('hourly', '小时工', 4, 0, '2002-01-01'),
      ('consultant', '顾问', 1, 0, '2024-09-28'),
      ('part_time', '兼职人员', 2, 0, '2025-06-29'),
      ('full_time', '全日制用工方式', NULL, 1, '2018-01-01'),
      ('non_full_time', '非全日制用工方式', NULL, 2, '2018-01-01'),
      ('dispatch', '劳务派遣', 2, 3, '2022-02-07')
    ) p(code,name,category,display_order,effective_date);
    UPDATE employment_payload_versions v SET employment_form=(SELECT f.code FROM employment_forms f
      WHERE f.tenant_id=t.id AND f.name=v.employment_form) WHERE v.tenant_id=t.id;
    UPDATE employment_records v SET employment_form=(SELECT f.code FROM employment_forms f
      WHERE f.tenant_id=t.id AND f.name=v.employment_form) WHERE v.tenant_id=t.id;
    UPDATE part_time_request_versions v SET employment_form=(SELECT f.code FROM employment_forms f
      WHERE f.tenant_id=t.id AND f.name=v.employment_form) WHERE v.tenant_id=t.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
--> statement-breakpoint
ALTER TABLE employment_payload_versions ENABLE TRIGGER employment_payload_versions_append_only;
--> statement-breakpoint
ALTER TABLE employment_records ENABLE TRIGGER employment_records_append_only;
--> statement-breakpoint
ALTER TABLE part_time_request_versions ENABLE TRIGGER part_time_request_versions_append_only;
--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_form_fk" FOREIGN KEY ("tenant_id","employment_form") REFERENCES "public"."employment_forms"("tenant_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_form_fk" FOREIGN KEY ("tenant_id","employment_form") REFERENCES "public"."employment_forms"("tenant_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_time_request_versions" ADD CONSTRAINT "part_time_request_versions_form_fk" FOREIGN KEY ("tenant_id","employment_form") REFERENCES "public"."employment_forms"("tenant_id","code") ON DELETE no action ON UPDATE no action;