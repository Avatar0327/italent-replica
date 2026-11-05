-- F-441：同级顺序号的排序键由 lpad(顺序号::text) 改为数值保序编码。负号 '-' 的字典序在数字之前，负数顺序号
-- （-1、-5）会按字符串排到 0 之后甚至排乱；加 2147483648 偏移后落在 [0, 4294967295]，定宽 10 位的字符串比较
-- 与数值比较一致；空顺序号用独立哨兵 4294967296（严格大于全部 int32 偏移值的上界 4294967295，仍是 10 位），
-- 不与合法的 2147483647 共值，保证 NULL 恒排在全部合法顺序号之后。其余函数体与 0027 相同。
CREATE OR REPLACE FUNCTION personnel_refresh_org_sort_ranks(p_tenant uuid, p_from date) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  DELETE FROM personnel_org_sort_ranks WHERE tenant_id = p_tenant AND valid_from >= p_from;
  UPDATE personnel_org_sort_ranks SET valid_to = p_from WHERE tenant_id = p_tenant AND valid_to > p_from;
  INSERT INTO personnel_org_sort_ranks (tenant_id, org_id, valid_from, valid_to, sort_number)
  WITH RECURSIVE bounds AS (
    SELECT p_from AS d
    UNION
    SELECT start_date FROM org_versions WHERE tenant_id = p_tenant AND start_date > p_from
    UNION
    SELECT stop_date + 1 FROM org_versions
      WHERE tenant_id = p_tenant AND stop_date >= p_from AND stop_date < DATE '9999-12-31'
  ), points AS (
    SELECT d, row_number() OVER (ORDER BY d) AS k, lead(d) OVER (ORDER BY d) AS next_d FROM bounds
  ), current_versions AS (
    SELECT DISTINCT ON (p.k, v.org_id) p.k, p.d, v.id, v.org_id, v.code, v.enabled, v.stop_date
    FROM points p JOIN org_versions v ON v.tenant_id = p_tenant AND v.start_date <= p.d
    ORDER BY p.k, v.org_id, v.start_date DESC, v.version_no DESC
  ), paths(k, org_id, sort_path, visited) AS (
    SELECT c.k, c.org_id, ARRAY[c.code]::text[], ARRAY[c.org_id] FROM current_versions c
    WHERE c.org_id = p_tenant AND c.enabled AND c.stop_date >= c.d
    UNION ALL
    SELECT c.k, c.org_id,
      p.sort_path || (lpad(COALESCE(h.sequence::bigint + 2147483648, 4294967296)::text, 10, '0') || ':' || c.code),
      p.visited || c.org_id
    FROM current_versions c
    JOIN org_hierarchy_links h ON h.tenant_id = p_tenant AND h.version_id = c.id AND h.dimension = 'admin'
    JOIN paths p ON p.k = c.k AND p.org_id = h.parent_org_id
    WHERE c.enabled AND c.stop_date >= c.d AND NOT c.org_id = ANY(p.visited)
  ), ranked AS (
    SELECT k, org_id, row_number() OVER (PARTITION BY k ORDER BY sort_path)::integer AS n FROM paths
  ), spans AS (
    SELECT org_id, n, min(k) AS first_k, max(k) AS last_k
    FROM (SELECT org_id, n, k, k - row_number() OVER (PARTITION BY org_id, n ORDER BY k) AS grp FROM ranked) r
    GROUP BY org_id, n, grp
  )
  SELECT p_tenant, s.org_id, f.d, COALESCE(l.next_d, DATE 'infinity'), s.n
  FROM spans s JOIN points f ON f.k = s.first_k JOIN points l ON l.k = s.last_k;
  -- 与 p_from 之前名次相同的分段接回一段，增量刷新与全量重算的分段逐行一致。
  WITH joined AS (
    DELETE FROM personnel_org_sort_ranks n USING personnel_org_sort_ranks o
    WHERE n.tenant_id = p_tenant AND n.valid_from = p_from AND o.tenant_id = p_tenant AND o.org_id = n.org_id
      AND o.valid_to = p_from AND o.sort_number = n.sort_number
    RETURNING n.org_id, n.valid_to
  )
  UPDATE personnel_org_sort_ranks o SET valid_to = j.valid_to FROM joined j
  WHERE o.tenant_id = p_tenant AND o.org_id = j.org_id AND o.valid_to = p_from;
END $$;
--> statement-breakpoint
-- 存量租户按新排序键全量重算一次（表已 FORCE RLS，按租户切换隔离上下文）；新库没有租户，空操作。
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    PERFORM personnel_refresh_org_sort_ranks(t.id, DATE '0001-01-01');
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
