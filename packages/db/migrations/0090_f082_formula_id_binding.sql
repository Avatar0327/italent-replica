CREATE TABLE "talent_review_calc_item_refs" (
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "talent_review_calc_item_refs_tenant_id_item_id_field_id_pk" PRIMARY KEY("tenant_id","item_id","field_id"),
	CONSTRAINT "talent_review_calc_item_refs_kind" CHECK ("talent_review_calc_item_refs"."kind" IN ('bound','candidate'))
);
--> statement-breakpoint
CREATE TABLE "talent_review_field_catalog_versions" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "talent_review_calc_rule_items" DROP CONSTRAINT "talent_review_calc_rule_items_priority";--> statement-breakpoint
ALTER TABLE "talent_review_calc_rule_items" ADD COLUMN "formula_binding" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "talent_review_calc_rule_items" ADD COLUMN "binding_issue" text;--> statement-breakpoint
-- 引用表的复合外键要引用 (tenant_id, id)，复合唯一键须先建
ALTER TABLE "talent_review_calc_rule_items" ADD CONSTRAINT "talent_review_calc_rule_items_tenant_id" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "talent_review_calc_item_refs" ADD CONSTRAINT "talent_review_calc_item_refs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_calc_item_refs" ADD CONSTRAINT "talent_review_calc_item_refs_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."talent_review_calc_rule_items"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_calc_item_refs" ADD CONSTRAINT "talent_review_calc_item_refs_field_fk" FOREIGN KEY ("tenant_id","field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_field_catalog_versions" ADD CONSTRAINT "talent_review_field_catalog_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "talent_review_calc_item_refs_field" ON "talent_review_calc_item_refs" USING btree ("tenant_id","field_id");--> statement-breakpoint
ALTER TABLE "talent_review_calc_rule_items" ADD CONSTRAINT "talent_review_calc_rule_items_binding" CHECK ("talent_review_calc_rule_items"."formula_binding" IN ('bound','legacy','unresolved'));--> statement-breakpoint
ALTER TABLE "talent_review_calc_rule_items" ADD CONSTRAINT "talent_review_calc_rule_items_priority" CHECK ("talent_review_calc_rule_items"."priority" BETWEEN 0 AND 1000000);
--> statement-breakpoint
-- F-082（F082-1）：新表的租户隔离与最小权限（AGENTS §2 租户隔离；guard-rls）。
-- 引用表随计算项目整项替换（删旧插新），应用角色需要 DELETE；版本行只增改，不删。
SELECT enable_tenant_isolation('talent_review_calc_item_refs');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_field_catalog_versions');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_review_calc_item_refs TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON talent_review_field_catalog_versions TO app_user;
--> statement-breakpoint
-- 存量租户：已有盘点字段的租户各得一行字段目录版本（版本 0）；没有字段的租户由首次写入时补行（INSERT … ON CONFLICT DO NOTHING）。
-- 迁移角色是表属主，FORCE RLS 对它同样生效，所以逐租户设置 app.tenant_id 再写（与租户备份同一做法）。
-- 存量计算项目的 formula_binding 取列默认值 legacy；引用表为空，由平台改绑命令（F082-5）按租户填写。
DO $$
DECLARE
  tenant uuid;
BEGIN
  FOR tenant IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tenant::text, true);
    INSERT INTO talent_review_field_catalog_versions (tenant_id)
    SELECT tenant WHERE EXISTS (SELECT 1 FROM talent_review_fields WHERE tenant_id = tenant)
    ON CONFLICT (tenant_id) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
