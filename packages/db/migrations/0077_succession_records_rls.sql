-- R3-T05 A1：继任记录与目标锁的租户隔离、区间排他、授权，以及读侧共用的 SQL 谓词 / 触发器（设计 §1.1、§8.4）。
-- 1) 租户隔离（AGENTS §2；guard-rls）。记录只软删除（deleted_at），应用角色不授 DELETE；目标锁行要 FOR UPDATE，需要 UPDATE。
SELECT enable_tenant_isolation('succession_records');
--> statement-breakpoint
SELECT enable_tenant_isolation('succession_target_locks');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON succession_records TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON succession_target_locks TO app_user;
--> statement-breakpoint
-- 2) 区间排他（DEC-305②，照原站；btree_gist 见 0001）：同目标同继任者任何两条未删除记录的 [开始, 结束) 不得重叠，含历史；
--    首尾相接与零长度 [d, d) 不算重叠。冲突映射 409 SUCCESSION_DUPLICATE / SUCCESSION_PERIOD_OVERLAP 在 A2，这里是兜底。
ALTER TABLE succession_records ADD CONSTRAINT succession_records_no_overlap EXCLUDE USING gist (
  tenant_id WITH =,
  succession_type WITH =,
  (COALESCE(target_org_id, target_position_id)) WITH =,
  successor_employee_id WITH =,
  daterange(start_date, end_date, '[)') WITH &&
) WHERE (deleted_at IS NULL);
--> statement-breakpoint
-- 3) 已删除的记录不占用准备度：插入 / 更新时只要 deleted_at 非空就清掉 readiness_id（外键 RESTRICT 只挡未删除记录；
--    审计快照在应用层写，保留删除前的引用）。
CREATE FUNCTION succession_records_release_readiness() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    NEW.readiness_id := NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER succession_records_release_readiness BEFORE INSERT OR UPDATE ON succession_records
  FOR EACH ROW EXECUTE FUNCTION succession_records_release_readiness();
--> statement-breakpoint
-- 4) SELF 谓词（设计 §8.4；SC-R7）：记录“是本人的” ⇔ 查看人绑定的员工，在请求当日是该组织目标的负责人，或是该职位目标的现任。
--    列表 / 地图 / 审计 / 回执共用这一个定义。版本取法同 org / job 读模型（start_date <= 当日的最新版本且 stop_date >= 当日）；
--    现任 = 当日时间轴上的主职任职，人员状态不是待入职 1 / 调出 4 / 退休 6 / 离职 8（§4.1）。按调用者权限执行（RLS 仍生效）。
CREATE FUNCTION succession_self_target_sql(
  p_tenant uuid, p_user uuid, p_type text, p_org uuid, p_position uuid, p_today date
) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
  AS $$
  SELECT EXISTS (
    SELECT 1 FROM permission_user_person_links l
    WHERE l.tenant_id = p_tenant AND l.user_id = p_user AND (
      (p_type = 'org' AND p_org IS NOT NULL AND EXISTS (
        SELECT 1 FROM (
          SELECT v.person_in_charge_id, v.stop_date FROM org_versions v
          WHERE v.tenant_id = p_tenant AND v.org_id = p_org AND v.start_date <= p_today
          ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1
        ) ov WHERE ov.stop_date >= p_today AND ov.person_in_charge_id = l.employee_id))
      OR (p_type = 'position' AND p_position IS NOT NULL AND EXISTS (
        SELECT 1 FROM employment_timeline t
          JOIN employment_records r ON r.tenant_id = t.tenant_id AND r.id = t.record_id
          JOIN LATERAL employment_record_status(t.tenant_id, r.id) s ON true
        WHERE t.tenant_id = p_tenant AND t.employee_id = l.employee_id AND t.valid_during @> p_today
          AND r.position_id = p_position AND r.service_type = 'primary'
          AND s.employee_status NOT IN (1, 4, 6, 8)))
    )
  )
$$;
--> statement-breakpoint
-- 5) 租户本地“今天”（DEC-056）：审计查看规则是纯 SQL，拿不到请求上下文的时区，而应用角色不能读 tenants，所以用一个
--    只回答当前租户的 SECURITY DEFINER 函数（同 0033 的 tenant_member_accounts 做法）；其他租户一律返回空。
CREATE FUNCTION succession_tenant_today(p_tenant uuid) RETURNS date
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT (now() AT TIME ZONE t.timezone)::date FROM tenants t
    WHERE t.id = p_tenant AND p_tenant = current_tenant_id()
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION succession_tenant_today(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION succession_tenant_today(uuid) TO app_user;
