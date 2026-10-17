-- R2-T03 B3-1（离职设计 §5.8）：离职落地时摘下同周期、排在它之后的已落地调动的时间轴行（记录、载荷版本、状态事件都保留），
-- 员工自离职生效日起即为离职。覆盖校验原本要求“每条未墓碑的主职记录恰有一行投影”，这里放行被离职摘下的调动：
-- 台账 exit_effects 有 future_transfer_detached 行指向该记录，且摘下它的离职记录仍在时间轴上（离职被撤销 / 删除后
-- 离职投影消失，挂回投影才能通过校验——撤销路径在 B4）。其余与 0137 的函数逐行相同。
CREATE OR REPLACE FUNCTION verify_employment_timeline_coverage() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  checked_tenant uuid;
  checked_employee uuid;
  active_count bigint;
  projection_count bigint;
  earliest_start date;
  actual_coverage datemultirange;
BEGIN
  IF TG_OP = 'DELETE' THEN
    checked_tenant := OLD.tenant_id;
    checked_employee := OLD.employee_id;
  ELSE
    checked_tenant := NEW.tenant_id;
    checked_employee := NEW.employee_id;
  END IF;

  -- 服务通常已持锁；约束本身也串行检查，防止绕过服务的并发写产生不完整时间轴。
  PERFORM 1 FROM public.employment_employees
    WHERE tenant_id = checked_tenant AND id = checked_employee FOR UPDATE;

  SELECT count(*), min(r.start_date) INTO active_count, earliest_start
    FROM public.employment_records r
    WHERE r.tenant_id = checked_tenant AND r.employee_id = checked_employee
      AND r.service_type = 'primary'
      AND NOT EXISTS (
        SELECT 1 FROM public.employment_record_tombstones d
        WHERE d.tenant_id = r.tenant_id AND d.record_id = r.id
      )
      AND NOT (
        NOT EXISTS (SELECT 1 FROM public.employment_timeline own
          WHERE own.tenant_id = r.tenant_id AND own.record_id = r.id)
        AND EXISTS (
          SELECT 1 FROM public.exit_effects x
          JOIN public.employment_timeline leave_row ON leave_row.tenant_id = x.tenant_id
            AND leave_row.record_id = x.business_id
          WHERE x.tenant_id = r.tenant_id AND x.kind = 'future_transfer_detached' AND x.target_id = r.id)
      );

  SELECT count(*), range_agg(p.valid_during) INTO projection_count, actual_coverage
    FROM public.employment_timeline p
    WHERE p.tenant_id = checked_tenant AND p.employee_id = checked_employee;

  -- 投影主键与复合 FK 已保证每个投影仅对应一条同员工、同日期的业务记录。
  IF active_count <> projection_count OR EXISTS (
    SELECT 1 FROM public.employment_timeline p
    JOIN public.employment_record_tombstones d
      ON d.tenant_id = p.tenant_id AND d.record_id = p.record_id
    WHERE p.tenant_id = checked_tenant AND p.employee_id = checked_employee
  ) THEN
    RAISE EXCEPTION 'every active employment record requires one projection'
      USING ERRCODE = '23514', CONSTRAINT = 'employment_timeline_complete';
  END IF;

  IF active_count > 0 AND actual_coverage IS DISTINCT FROM
      datemultirange(daterange(earliest_start, NULL, '[)')) THEN
    RAISE EXCEPTION 'employment timeline must cover continuously through infinity'
      USING ERRCODE = '23514', CONSTRAINT = 'employment_timeline_complete';
  END IF;
  RETURN NULL;
END;
$$;
