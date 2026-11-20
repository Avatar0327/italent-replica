CREATE TABLE "esign_offer_sources" (
	"tenant_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "esign_offer_sources_tenant_id_offer_id_pk" PRIMARY KEY("tenant_id","offer_id")
);
--> statement-breakpoint
ALTER TABLE "esign_scene_settings" DROP CONSTRAINT "esign_scene_settings_scene";--> statement-breakpoint
ALTER TABLE "esign_tasks" DROP CONSTRAINT "esign_tasks_scene";--> statement-breakpoint
ALTER TABLE "esign_tasks" DROP CONSTRAINT "esign_tasks_origin";--> statement-breakpoint
ALTER TABLE "esign_tasks" DROP CONSTRAINT "esign_tasks_revoke_cause";--> statement-breakpoint
DROP INDEX "esign_tasks_one_signing";--> statement-breakpoint
ALTER TABLE "esign_tasks" ALTER COLUMN "business_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD COLUMN "offer_id" uuid;--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD COLUMN "source_revision" integer;--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD COLUMN "variable_read_fields" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "esign_offer_sources" ADD CONSTRAINT "esign_offer_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD CONSTRAINT "esign_tasks_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."esign_offer_sources"("tenant_id","offer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "esign_tasks_one_signing_business" ON "esign_tasks" USING btree ("tenant_id","scene","business_id") WHERE "esign_tasks"."status" = 'signing' AND "esign_tasks"."business_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "esign_tasks_one_signing_offer" ON "esign_tasks" USING btree ("tenant_id","offer_id") WHERE "esign_tasks"."status" = 'signing' AND "esign_tasks"."scene" = 'offer';--> statement-breakpoint
CREATE INDEX "esign_tasks_offer" ON "esign_tasks" USING btree ("tenant_id","offer_id");--> statement-breakpoint
ALTER TABLE "esign_scene_settings" ADD CONSTRAINT "esign_scene_settings_scene" CHECK ("esign_scene_settings"."scene" IN ('transfer', 'offer', 'entry'));--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD CONSTRAINT "esign_tasks_source" CHECK (("esign_tasks"."scene" IN ('transfer', 'entry') AND "esign_tasks"."business_id" IS NOT NULL AND "esign_tasks"."offer_id" IS NULL)
        OR ("esign_tasks"."scene" = 'offer' AND "esign_tasks"."business_id" IS NULL AND "esign_tasks"."offer_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD CONSTRAINT "esign_tasks_source_revision" CHECK (("esign_tasks"."scene" = 'transfer' AND ("esign_tasks"."source_revision" IS NULL OR "esign_tasks"."source_revision" > 0))
        OR ("esign_tasks"."scene" <> 'transfer' AND "esign_tasks"."source_revision" IS NOT NULL AND "esign_tasks"."source_revision" > 0));--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD CONSTRAINT "esign_tasks_variable_fields" CHECK ("esign_tasks"."variable_read_fields" IN (ARRAY[]::text[], ARRAY['name']::text[], ARRAY['code']::text[],
        ARRAY['name', 'code']::text[]));--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD CONSTRAINT "esign_tasks_scene" CHECK ("esign_tasks"."scene" IN ('transfer', 'offer', 'entry'));--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD CONSTRAINT "esign_tasks_origin" CHECK ("esign_tasks"."origin" IN ('activation', 'manual') AND ("esign_tasks"."scene" = 'transfer' OR "esign_tasks"."origin" = 'manual'));--> statement-breakpoint
ALTER TABLE "esign_tasks" ADD CONSTRAINT "esign_tasks_revoke_cause" CHECK ("esign_tasks"."revoke_cause" IS NULL OR "esign_tasks"."revoke_cause" IN
        ('manual', 'business_deleted', 'source_cancelled', 'source_changed'));--> statement-breakpoint
-- F-505 S1（设计 §4.1）：Offer 签署来源锚点。行级安全 ENABLE + FORCE；只授 SELECT / INSERT / UPDATE（UPDATE 仅用于标记 deleted_at）。
SELECT enable_tenant_isolation('esign_offer_sources');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON esign_offer_sources TO app_user;
--> statement-breakpoint
-- 插入前确认同租户同 ID 的 Offer 确实存在（有意不建指向 offers 的永久外键：Offer 会被物理删除，锚点要留下来）。
CREATE FUNCTION esign_offer_sources_check_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM offers WHERE tenant_id = NEW.tenant_id AND id = NEW.offer_id) THEN
    RAISE EXCEPTION 'esign_offer_sources 的 Offer 不存在（本租户）' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'esign_offer_sources 新建时不得带删除标记' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER esign_offer_sources_check_insert BEFORE INSERT ON esign_offer_sources
  FOR EACH ROW EXECUTE FUNCTION esign_offer_sources_check_insert();
--> statement-breakpoint
-- 更新只允许把 deleted_at 从空标成非空（一次，不可撤销）；键与创建时间不可改。
CREATE FUNCTION esign_offer_sources_check_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.offer_id <> OLD.offer_id OR NEW.created_at <> OLD.created_at
     OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'esign_offer_sources 只允许一次性标记 deleted_at' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER esign_offer_sources_check_update BEFORE UPDATE ON esign_offer_sources
  FOR EACH ROW EXECUTE FUNCTION esign_offer_sources_check_update();
--> statement-breakpoint
-- 锚点禁止物理删除（含 TRUNCATE）。
CREATE FUNCTION esign_offer_sources_forbid_delete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'esign_offer_sources 禁止物理删除，只能标记 deleted_at' USING ERRCODE = 'object_not_in_prerequisite_state';
END $$;
--> statement-breakpoint
CREATE TRIGGER esign_offer_sources_no_delete BEFORE DELETE OR TRUNCATE ON esign_offer_sources
  FOR EACH STATEMENT EXECUTE FUNCTION esign_offer_sources_forbid_delete();
--> statement-breakpoint
-- Offer 物理删除的兜底约束：有锚点却没标记、或仍有 signing 任务，一律拒绝，防止漏接删除内核产生孤立在途任务。
-- 只拒绝、不发通知；无锚点的旧业务照常删除。
CREATE FUNCTION offers_guard_esign_sources() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM esign_offer_sources
             WHERE tenant_id = OLD.tenant_id AND offer_id = OLD.id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Offer 有签署来源锚点但未标记删除，拒绝物理删除' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF EXISTS (SELECT 1 FROM esign_tasks
             WHERE tenant_id = OLD.tenant_id AND offer_id = OLD.id AND status = 'signing') THEN
    RAISE EXCEPTION 'Offer 仍有签署中的任务，拒绝物理删除' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER offers_guard_esign_sources BEFORE DELETE ON offers
  FOR EACH ROW EXECUTE FUNCTION offers_guard_esign_sources();
