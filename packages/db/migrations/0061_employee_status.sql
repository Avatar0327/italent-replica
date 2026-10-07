-- F-022：任职版本补“人员状态”“入职状态”（docs/02_业务建模/15 §9，Q-M0-96～99；DEC-125 / DEC-215）。
-- 两列随任职版本（employment_payload_versions、employment_records）存储，表示该版本的目标状态，天然带生效日期与历史；
-- 不另建“变更前”列（AGENTS §2）。编码照原站：人员状态 待入职 1 / 试用 2 / 正式 3 / 调出 4 / 待调入 5 / 退休 6 /
-- 离职 8 / 非正式 12；入职状态 正常 0 / 取消 1 / 延期 2，可为空。
-- 1) 先加可空列，回填后再设 NOT NULL；2) 插入触发器统一继承（所有追加版本的路径共用）；3) 存量回填，不改其他列。
ALTER TABLE "employment_payload_versions" ADD COLUMN "employee_status" smallint;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD COLUMN "entry_status" smallint;--> statement-breakpoint
ALTER TABLE "employment_records" ADD COLUMN "employee_status" smallint;--> statement-breakpoint
ALTER TABLE "employment_records" ADD COLUMN "entry_status" smallint;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_employee_status" CHECK ("employment_payload_versions"."employee_status" IN (1, 2, 3, 4, 5, 6, 8, 12));--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_entry_status" CHECK ("employment_payload_versions"."entry_status" IN (0, 1, 2));--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_employee_status" CHECK ("employment_records"."employee_status" IN (1, 2, 3, 4, 5, 6, 8, 12));--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_entry_status" CHECK ("employment_records"."entry_status" IN (0, 1, 2));--> statement-breakpoint
-- 一条已生效任职记录当前的两个状态：最新记录快照优先，否则取底表行（与读取口径一致）。
CREATE FUNCTION employment_record_status(p_tenant uuid, p_record uuid)
  RETURNS TABLE (employee_status smallint, entry_status smallint)
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
  AS $$
  SELECT s.employee_status, s.entry_status FROM (
    (SELECT p.employee_status, p.entry_status, 0 AS o FROM employment_payload_versions p
      WHERE p.tenant_id = p_tenant AND p.business_id = p_record AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1)
    UNION ALL
    (SELECT r.employee_status, r.entry_status, 1 FROM employment_records r
      WHERE r.tenant_id = p_tenant AND r.id = p_record)
  ) s ORDER BY s.o LIMIT 1
$$;
--> statement-breakpoint
-- 生效日当天及以前的最后一条（同日取最后一次操作，DEC-108）；给出周期时只看该周期。
CREATE FUNCTION employment_timeline_predecessor(p_tenant uuid, p_employee uuid, p_date date, p_staff uuid)
  RETURNS uuid
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
  AS $$
  SELECT t.record_id FROM employment_timeline t
  WHERE t.tenant_id = p_tenant AND t.employee_id = p_employee AND t.start_date <= p_date
    AND (p_staff IS NULL OR t.staff_id = p_staff)
  ORDER BY t.start_date DESC, t.sort_order DESC LIMIT 1
$$;
--> statement-breakpoint
-- 本身决定人员状态的业务（15 §9.2）：转正 → 正式；离职 → 离职；退休 → 退休。入职类（含实习转正）由入职端口决定（默认正式）。
CREATE FUNCTION employment_kind_status(p_kind text) RETURNS smallint
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public
  AS $$
  SELECT CASE p_kind WHEN 'regularization' THEN 3 WHEN 'leave' THEN 8 WHEN 'retirement' THEN 6 END::smallint
$$;
--> statement-breakpoint
-- 载荷版本未显式给出状态时（应用层只在入职端口、状态流转端口显式给出）：
-- 记录快照 → 继承该记录当前值；同一业务的后续版本 → 继承上一版本；首版 → 入职类（含实习转正，DEC-234）正式、
-- 转正 / 离职 / 退休取本身状态，
-- 其余继承时间轴前一条（入职状态一律继承）。都取不到时保持空，由 NOT NULL 拒绝写入（fail-closed）。
CREATE FUNCTION employment_payload_status_inherit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_status smallint;
  v_entry smallint;
BEGIN
  IF NEW.employee_status IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.is_record_snapshot THEN
    SELECT s.employee_status, s.entry_status INTO v_status, v_entry
      FROM employment_record_status(NEW.tenant_id, NEW.business_id) s;
  END IF;
  IF v_status IS NULL AND NEW.previous_version_id IS NOT NULL THEN
    SELECT p.employee_status, p.entry_status INTO v_status, v_entry FROM employment_payload_versions p
      WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.previous_version_id;
  END IF;
  IF v_status IS NULL THEN
    IF NEW.kind IN ('hire', 'rehire', 'retire_rehire', 'intern_regularization') THEN
      v_status := 3;
      v_entry := NULL;
    ELSE
      SELECT s.employee_status, s.entry_status INTO v_status, v_entry
        FROM employment_record_status(NEW.tenant_id, employment_timeline_predecessor(
          NEW.tenant_id, NEW.employee_id, NEW.effective_date, NEW.selected_staff_id)) s;
      v_status := COALESCE(employment_kind_status(NEW.kind), v_status);
    END IF;
  END IF;
  NEW.employee_status := v_status;
  NEW.entry_status := v_entry;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 任职记录落地：入职类（含实习转正，DEC-234）取承载它的载荷版本（入职端口写入的待入职 / 试用 / 正式）；其余以前一条（继承来源，
-- 即 DEC-108 实际插入点之前那条；缺省按时间轴）为准，转正 / 离职 / 退休再取本身状态。
CREATE FUNCTION employment_record_status_inherit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_status smallint;
  v_entry smallint;
BEGIN
  IF NEW.employee_status IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.kind IN ('hire', 'rehire', 'retire_rehire', 'intern_regularization') THEN
    SELECT p.employee_status, p.entry_status INTO v_status, v_entry FROM employment_payload_versions p
      WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payload_version_id;
  ELSE
    SELECT s.employee_status, s.entry_status INTO v_status, v_entry
      FROM employment_record_status(NEW.tenant_id, COALESCE(NEW.inheritance_source_id,
        employment_timeline_predecessor(NEW.tenant_id, NEW.employee_id, NEW.start_date, NEW.staff_id))) s;
    v_status := COALESCE(employment_kind_status(NEW.kind), v_status);
  END IF;
  NEW.employee_status := v_status;
  NEW.entry_status := v_entry;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 存量回填（迁移属主执行；两表强制 RLS，按租户设置 app.tenant_id 并显式按租户过滤；临时卸下只追加触发器，只写两个新列）：
-- 记录：按（员工, 周期）在时间轴上排序。入职类（新增 / 重聘 / 退休返聘入职，及按入职处理的实习转正，DEC-234 ①）
--   = 有试用期结束日的有效合同（未删除、未作废、已生效、签于本周期内；实习转正只看转正生效日及以后签的）→ 试用，否则正式；
--   雇佣关系为实习生的一律正式（DEC-234 ②）；转正 → 正式；离职 → 离职；退休 → 退休；调动 / 组织调整 → 继承前一条
--   （因此转正之前为试用、转正及之后为正式）。已删除（不在时间轴上）的记录：本身决定的取本身，其余取同周期生效日
--   不晚于它的最后一条。R1 没有“添加待入职”入口，存量没有待入职记录（DEC-223：未来日期的办理入职写目标状态）；
--   入职状态全部为空。
-- 载荷：记录快照与已落地业务的各版本 = 该记录的值；未落地的申请：入职类（含实习转正）正式、转正 / 离职 / 退休取本身状态，
--   其余取生效日前一条（同周期）的值；都取不到时按正式。
ALTER TABLE employment_records DISABLE TRIGGER employment_records_append_only;
--> statement-breakpoint
ALTER TABLE employment_payload_versions DISABLE TRIGGER employment_payload_versions_append_only;
--> statement-breakpoint
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    WITH base AS (
      SELECT r.id, r.employee_id, r.staff_id, r.start_date, tl.sort_order, r.created_at,
        COALESCE(employment_kind_status(r.kind),
          CASE WHEN r.kind IN ('hire', 'rehire', 'retire_rehire', 'intern_regularization') THEN
          CASE WHEN r.employ_type = 'intern' THEN 3 WHEN EXISTS (
            SELECT 1 FROM contract_records c
            WHERE c.tenant_id = r.tenant_id AND c.employee_id = r.employee_id AND NOT c.deleted
              AND c.status <> 'void' AND c.approval_status = 'effective' AND c.probation_end_date IS NOT NULL
              AND c.effective_date >= CASE WHEN r.kind = 'intern_regularization' THEN r.start_date ELSE r.entry_date END
              AND NOT EXISTS (SELECT 1 FROM employment_cycles n WHERE n.tenant_id = r.tenant_id
                AND n.employee_id = r.employee_id AND n.entry_date > r.entry_date AND n.entry_date <= c.effective_date)
          ) THEN 2 ELSE 3 END END)::smallint AS own
      FROM employment_records r
      JOIN employment_timeline tl ON tl.tenant_id = r.tenant_id AND tl.record_id = r.id
      WHERE r.tenant_id = t.id
    ), grouped AS (
      SELECT b.*, count(b.own) OVER (PARTITION BY b.employee_id, b.staff_id
        ORDER BY b.start_date, b.sort_order, b.created_at, b.id) AS grp
      FROM base b
    ), resolved AS (
      SELECT g.id, max(g.own) OVER (PARTITION BY g.employee_id, g.staff_id, g.grp) AS status FROM grouped g
    )
    UPDATE employment_records r SET employee_status = COALESCE(resolved.status, 3)
    FROM resolved WHERE r.tenant_id = t.id AND r.id = resolved.id;
    UPDATE employment_records r SET employee_status = COALESCE(employment_kind_status(r.kind),
        CASE WHEN r.kind IN ('hire', 'rehire', 'retire_rehire', 'intern_regularization') THEN 3 END,
        (SELECT p.employee_status FROM employment_records p
          JOIN employment_timeline pt ON pt.tenant_id = p.tenant_id AND pt.record_id = p.id
          WHERE p.tenant_id = r.tenant_id AND p.employee_id = r.employee_id AND p.staff_id = r.staff_id
            AND pt.start_date <= r.start_date
          ORDER BY pt.start_date DESC, pt.sort_order DESC LIMIT 1), 3)
    WHERE r.tenant_id = t.id AND r.employee_status IS NULL;
    UPDATE employment_payload_versions p SET employee_status = r.employee_status
    FROM employment_records r
    WHERE p.tenant_id = t.id AND r.tenant_id = p.tenant_id AND r.id = p.business_id;
    UPDATE employment_payload_versions p SET employee_status = COALESCE(employment_kind_status(p.kind),
        CASE WHEN p.kind IN ('hire', 'rehire', 'retire_rehire', 'intern_regularization') THEN 3 END,
        (SELECT r.employee_status FROM employment_records r
          WHERE r.tenant_id = p.tenant_id AND r.id = employment_timeline_predecessor(
            p.tenant_id, p.employee_id, p.effective_date, p.selected_staff_id)), 3)
    WHERE p.tenant_id = t.id AND p.employee_status IS NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
--> statement-breakpoint
ALTER TABLE employment_payload_versions ENABLE TRIGGER employment_payload_versions_append_only;
--> statement-breakpoint
ALTER TABLE employment_records ENABLE TRIGGER employment_records_append_only;
--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ALTER COLUMN "employee_status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "employment_records" ALTER COLUMN "employee_status" SET NOT NULL;--> statement-breakpoint
CREATE TRIGGER employment_payload_versions_status_inherit BEFORE INSERT ON employment_payload_versions
  FOR EACH ROW EXECUTE FUNCTION employment_payload_status_inherit();
--> statement-breakpoint
CREATE TRIGGER employment_records_status_inherit BEFORE INSERT ON employment_records
  FOR EACH ROW EXECUTE FUNCTION employment_record_status_inherit();
