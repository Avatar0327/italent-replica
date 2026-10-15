-- F-140 约束 1 / 2（DEC-499）：人工计划生效日与系统实际执行日分字段存储，计划日只按业务内单调的 version_no 读取，
-- 不再从 outbox 改期事件按 (created_at, id) 推断（同一事务的事件共用 created_at、id 为随机 UUID，#100 第 7 轮 P2-01）。
-- 人工写日期的版本（trigger_business_id 为空：新建、草稿 / 驳回 / 审批中修改、审批编辑；首版）计划 = 本版本生效日；
-- 系统派生版本（迟到顺延、向后更新、序列同步、状态传播，trigger_business_id 非空）一律沿用上一版本的计划，
-- 只有 effective_date 记录实际写入日。该列一律由触发器推导，插入时传入的值被覆盖：任何写入方都不能直接设置计划。
ALTER TABLE "employment_payload_versions" ADD COLUMN "planned_effective_date" date;
--> statement-breakpoint
-- 存量回填（DEC-402 未上线，不做兼容，只保证迁移可执行）：按同一规则取“版本号不大于本版本的最后一个人工版本”的生效日。
-- 表强制 RLS，按租户设置 app.tenant_id；临时卸下只追加触发器，只写新列。
ALTER TABLE employment_payload_versions DISABLE TRIGGER employment_payload_versions_append_only;
--> statement-breakpoint
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    UPDATE employment_payload_versions p SET planned_effective_date = COALESCE(
      (SELECT m.effective_date FROM employment_payload_versions m
        WHERE m.tenant_id = p.tenant_id AND m.business_id = p.business_id AND m.version_no <= p.version_no
          AND (m.trigger_business_id IS NULL OR m.previous_version_id IS NULL)
        ORDER BY m.version_no DESC LIMIT 1),
      p.effective_date)
    WHERE p.tenant_id = t.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
--> statement-breakpoint
ALTER TABLE employment_payload_versions ENABLE TRIGGER employment_payload_versions_append_only;
--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ALTER COLUMN "planned_effective_date" SET NOT NULL;
--> statement-breakpoint
CREATE FUNCTION employment_payload_planned_date() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_planned date;
BEGIN
  IF NEW.trigger_business_id IS NULL OR NEW.previous_version_id IS NULL THEN
    v_planned := NEW.effective_date;
  ELSE
    SELECT p.planned_effective_date INTO v_planned FROM employment_payload_versions p
      WHERE p.tenant_id = NEW.tenant_id AND p.business_id = NEW.business_id AND p.id = NEW.previous_version_id;
    IF v_planned IS NULL THEN
      RAISE EXCEPTION 'employment payload version % has no previous planned effective date', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.planned_effective_date := v_planned;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER employment_payload_versions_planned_date BEFORE INSERT ON employment_payload_versions
  FOR EACH ROW EXECUTE FUNCTION employment_payload_planned_date();
