CREATE TABLE "employment_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"effective_date" date NOT NULL,
	"expiry_date" date DEFAULT '9999-12-31' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"preset_key" text,
	"deleted_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_types_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_types_nonempty" CHECK (btrim("employment_types"."name") <> ''),
	CONSTRAINT "employment_types_dates" CHECK ("employment_types"."effective_date" <= "employment_types"."expiry_date"),
	CONSTRAINT "employment_types_revision_order" CHECK ("employment_types"."revision" > 0 AND "employment_types"."display_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "employment_types" ADD CONSTRAINT "employment_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employment_types_tenant_preset" ON "employment_types" USING btree ("tenant_id","preset_key") WHERE "employment_types"."preset_key" IS NOT NULL;--> statement-breakpoint
-- F-323 / DEC-706：预置 8 条（17 §F-323）；旧自由文本按名称精确匹配映射到本租户预置 ID，未知置空；
-- 逐租户执行以支持 FORCE RLS 的 app_owner。
SELECT enable_tenant_isolation('employment_types');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON employment_types TO app_user;
--> statement-breakpoint
ALTER TABLE employment_payload_versions DISABLE TRIGGER employment_payload_versions_append_only;
--> statement-breakpoint
ALTER TABLE employment_records DISABLE TRIGGER employment_records_append_only;
--> statement-breakpoint
ALTER TABLE part_time_request_versions DISABLE TRIGGER part_time_request_versions_append_only;
--> statement-breakpoint
ALTER TABLE establishment_scheme_ranges DISABLE TRIGGER establishment_scheme_ranges_append_only;
--> statement-breakpoint
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    INSERT INTO employment_types(tenant_id,preset_key,name,display_order,effective_date)
    SELECT t.id, p.preset_key, p.name, p.display_order, p.effective_date::date
    FROM (VALUES
      ('yg_regular', 'YG正式员工', 1, '2026-05-22'),
      ('back_office', '职能后台', 1, '2018-01-01'),
      ('marketing', '市场运营', 2, '2018-01-01'),
      ('yg_probation', 'YG试用员工', 2, '2026-05-22'),
      ('yg_campus', 'YG校招生', 3, '2026-05-22'),
      ('engineering', '技术开发', 3, '2018-01-01'),
      ('yg_resigned', 'YG辞职员工', 4, '2026-05-22'),
      ('operations', '运维服务', 4, '2018-01-01')
    ) p(preset_key,name,display_order,effective_date);
    UPDATE employment_payload_versions v SET employment_type=(SELECT f.id::text FROM employment_types f
      WHERE f.tenant_id=t.id AND f.name=v.employment_type) WHERE v.tenant_id=t.id AND v.employment_type IS NOT NULL;
    UPDATE employment_records v SET employment_type=(SELECT f.id::text FROM employment_types f
      WHERE f.tenant_id=t.id AND f.name=v.employment_type) WHERE v.tenant_id=t.id AND v.employment_type IS NOT NULL;
    UPDATE part_time_request_versions v SET employment_type=(SELECT f.id::text FROM employment_types f
      WHERE f.tenant_id=t.id AND f.name=v.employment_type) WHERE v.tenant_id=t.id AND v.employment_type IS NOT NULL;
    -- 编制占编条件按字符串匹配任职字段：人员类别条件值同样按名称精确映射为 ID，未匹配的原样保留（与迁移前一样不命中新 ID）
    UPDATE establishment_scheme_ranges r SET conditions=jsonb_set(r.conditions, '{employmentType}', (
      SELECT COALESCE(jsonb_agg(COALESCE((SELECT to_jsonb(f.id::text) FROM employment_types f
        WHERE f.tenant_id=t.id AND f.name=e.value), to_jsonb(e.value)) ORDER BY e.ord), '[]'::jsonb)
      FROM jsonb_array_elements_text(r.conditions->'employmentType') WITH ORDINALITY e(value, ord)))
    WHERE r.tenant_id=t.id AND jsonb_typeof(r.conditions->'employmentType')='array';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ALTER COLUMN "employment_type" SET DATA TYPE uuid USING "employment_type"::uuid;
--> statement-breakpoint
ALTER TABLE "employment_records" ALTER COLUMN "employment_type" SET DATA TYPE uuid USING "employment_type"::uuid;
--> statement-breakpoint
ALTER TABLE "part_time_request_versions" ALTER COLUMN "employment_type" SET DATA TYPE uuid USING "employment_type"::uuid;
--> statement-breakpoint
ALTER TABLE employment_payload_versions ENABLE TRIGGER employment_payload_versions_append_only;
--> statement-breakpoint
ALTER TABLE employment_records ENABLE TRIGGER employment_records_append_only;
--> statement-breakpoint
ALTER TABLE part_time_request_versions ENABLE TRIGGER part_time_request_versions_append_only;
--> statement-breakpoint
ALTER TABLE establishment_scheme_ranges ENABLE TRIGGER establishment_scheme_ranges_append_only;
--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_type_fk" FOREIGN KEY ("tenant_id","employment_type") REFERENCES "public"."employment_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_type_fk" FOREIGN KEY ("tenant_id","employment_type") REFERENCES "public"."employment_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_time_request_versions" ADD CONSTRAINT "part_time_request_versions_type_fk" FOREIGN KEY ("tenant_id","employment_type") REFERENCES "public"."employment_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;