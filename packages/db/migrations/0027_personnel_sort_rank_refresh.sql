-- DEC-089：组织 / 职务排序号预计算并存储（DEC-037 / G-036：组织按行政路径的顺序号 + 编码，职务按编码）。
-- 名次随版本生效日期变化，按“生效区间”分段存储；org_versions / org_hierarchy_links / job_post_versions 的任何写入
-- （接口、导入、夹具直写）都在本事务提交前从受影响的最早生效日起重算全租户名次，读取直接按业务日期取值。
SELECT enable_tenant_isolation('personnel_org_sort_ranks');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "personnel_org_sort_ranks" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_post_sort_ranks');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "personnel_post_sort_ranks" TO app_user;
--> statement-breakpoint
-- 版本只影响其生效日之后的时点，所以只重算 [p_from, ∞)：区间端点取 p_from 与之后所有生效 / 失效日期，
-- 每个端点算一次名次，再把同一组织连续相同的名次合并成一段。
CREATE FUNCTION personnel_refresh_org_sort_ranks(p_tenant uuid, p_from date) RETURNS void
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
      p.sort_path || (lpad(COALESCE(h.sequence, 2147483647)::text, 10, '0') || ':' || c.code),
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
CREATE FUNCTION personnel_refresh_post_sort_ranks(p_tenant uuid, p_from date) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  DELETE FROM personnel_post_sort_ranks WHERE tenant_id = p_tenant AND valid_from >= p_from;
  UPDATE personnel_post_sort_ranks SET valid_to = p_from WHERE tenant_id = p_tenant AND valid_to > p_from;
  INSERT INTO personnel_post_sort_ranks (tenant_id, post_id, valid_from, valid_to, sort_number)
  WITH bounds AS (
    SELECT p_from AS d
    UNION
    SELECT start_date FROM job_post_versions WHERE tenant_id = p_tenant AND start_date > p_from
    UNION
    SELECT stop_date + 1 FROM job_post_versions
      WHERE tenant_id = p_tenant AND stop_date >= p_from AND stop_date < DATE '9999-12-31'
  ), points AS (
    SELECT d, row_number() OVER (ORDER BY d) AS k, lead(d) OVER (ORDER BY d) AS next_d FROM bounds
  ), current_versions AS (
    SELECT DISTINCT ON (p.k, v.object_id) p.k, p.d, v.object_id, v.code, v.enabled, v.stop_date
    FROM points p JOIN job_post_versions v ON v.tenant_id = p_tenant AND v.start_date <= p.d
    ORDER BY p.k, v.object_id, v.start_date DESC, v.version_no DESC
  ), ranked AS (
    SELECT k, object_id, row_number() OVER (PARTITION BY k ORDER BY code, object_id)::integer AS n
    FROM current_versions WHERE enabled AND stop_date >= d
  ), spans AS (
    SELECT object_id, n, min(k) AS first_k, max(k) AS last_k
    FROM (SELECT object_id, n, k, k - row_number() OVER (PARTITION BY object_id, n ORDER BY k) AS grp FROM ranked) r
    GROUP BY object_id, n, grp
  )
  SELECT p_tenant, s.object_id, f.d, COALESCE(l.next_d, DATE 'infinity'), s.n
  FROM spans s JOIN points f ON f.k = s.first_k JOIN points l ON l.k = s.last_k;
  -- 与 p_from 之前名次相同的分段接回一段，增量刷新与全量重算的分段逐行一致。
  WITH joined AS (
    DELETE FROM personnel_post_sort_ranks n USING personnel_post_sort_ranks o
    WHERE n.tenant_id = p_tenant AND n.valid_from = p_from AND o.tenant_id = p_tenant AND o.post_id = n.post_id
      AND o.valid_to = p_from AND o.sort_number = n.sort_number
    RETURNING n.post_id, n.valid_to
  )
  UPDATE personnel_post_sort_ranks o SET valid_to = j.valid_to FROM joined j
  WHERE o.tenant_id = p_tenant AND o.post_id = j.post_id AND o.valid_to = p_from;
END $$;
--> statement-breakpoint
-- 行级触发器只记录本事务每个租户受影响的最早生效日（事务级设置），真正的重算由下面的延迟约束触发器在提交前
-- 做一次，避免一次导入或全称同步写多条版本时反复重算。
CREATE FUNCTION personnel_sort_ranks_mark() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  row_tenant uuid;
  changed date;
  setting text;
  pending text;
  tenants text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_tenant := OLD.tenant_id;
  ELSE
    row_tenant := NEW.tenant_id;
  END IF;
  IF TG_TABLE_NAME = 'org_hierarchy_links' THEN
    SELECT start_date INTO changed FROM org_versions
      WHERE tenant_id = row_tenant AND id = CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  ELSIF TG_OP = 'DELETE' THEN
    changed := OLD.start_date;
  ELSIF TG_OP = 'UPDATE' THEN
    changed := least(OLD.start_date, NEW.start_date);
  ELSE
    changed := NEW.start_date;
  END IF;
  IF changed IS NULL THEN
    RETURN NULL;
  END IF;
  setting := 'personnel.' || TG_ARGV[0] || '_rank_from_' || replace(row_tenant::text, '-', '');
  pending := current_setting(setting, true);
  IF COALESCE(pending, '') = '' OR changed < pending::date THEN
    PERFORM set_config(setting, changed::text, true);
  END IF;
  tenants := COALESCE(current_setting('personnel.rank_tenants', true), '');
  IF position(row_tenant::text IN tenants) = 0 THEN
    PERFORM set_config('personnel.rank_tenants', tenants || row_tenant::text || ',', true);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- 并发：同一租户的重算以事务级咨询锁串行（多租户按 id 顺序加锁，避免死锁）；拿到锁之后的语句看得到先提交者的
-- 版本（READ COMMITTED，每条语句新快照），名次不会漏算。
CREATE FUNCTION personnel_sort_ranks_flush() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  tenants text := current_setting('personnel.rank_tenants', true);
  target uuid;
  key text;
  org_from text;
  post_from text;
BEGIN
  IF COALESCE(tenants, '') = '' THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('personnel.rank_tenants', '', true);
  FOR target IN SELECT DISTINCT t::uuid FROM unnest(string_to_array(rtrim(tenants, ','), ',')) t ORDER BY 1 LOOP
    key := replace(target::text, '-', '');
    org_from := current_setting('personnel.org_rank_from_' || key, true);
    post_from := current_setting('personnel.post_rank_from_' || key, true);
    PERFORM set_config('personnel.org_rank_from_' || key, '', true);
    PERFORM set_config('personnel.post_rank_from_' || key, '', true);
    PERFORM pg_advisory_xact_lock(hashtextextended('personnel_sort_ranks:' || target::text, 0));
    IF COALESCE(org_from, '') <> '' THEN
      PERFORM personnel_refresh_org_sort_ranks(target, org_from::date);
    END IF;
    IF COALESCE(post_from, '') <> '' THEN
      PERFORM personnel_refresh_post_sort_ranks(target, post_from::date);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "personnel_org_ranks_mark" AFTER INSERT OR UPDATE OR DELETE ON "org_versions"
  FOR EACH ROW EXECUTE FUNCTION personnel_sort_ranks_mark('org');
--> statement-breakpoint
CREATE TRIGGER "personnel_org_link_ranks_mark" AFTER INSERT OR UPDATE OR DELETE ON "org_hierarchy_links"
  FOR EACH ROW EXECUTE FUNCTION personnel_sort_ranks_mark('org');
--> statement-breakpoint
CREATE TRIGGER "personnel_post_ranks_mark" AFTER INSERT OR UPDATE OR DELETE ON "job_post_versions"
  FOR EACH ROW EXECUTE FUNCTION personnel_sort_ranks_mark('post');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "personnel_org_ranks_flush" AFTER INSERT OR UPDATE OR DELETE ON "org_versions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION personnel_sort_ranks_flush();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "personnel_org_link_ranks_flush" AFTER INSERT OR UPDATE OR DELETE ON "org_hierarchy_links"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION personnel_sort_ranks_flush();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "personnel_post_ranks_flush" AFTER INSERT OR UPDATE OR DELETE ON "job_post_versions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION personnel_sort_ranks_flush();
--> statement-breakpoint
-- 存量租户回填：按租户切换隔离上下文（表已 FORCE RLS），从最早日期全量计算一次。新库没有租户，空操作。
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    PERFORM personnel_refresh_org_sort_ranks(t.id, DATE '0001-01-01');
    PERFORM personnel_refresh_post_sort_ranks(t.id, DATE '0001-01-01');
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
