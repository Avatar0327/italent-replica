import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { scopeRows } from '../permission/scope-hierarchy.js';
import { managerIdentity } from '../permission/manager-identity.js';
import { scopeSql } from '../permission/module-access.js';
import { tenantLocalDate } from '@italent/domain';
import type { EmploymentContext, PageQuery } from '../employment/types.js';

export async function managerTeamQuery(tx: Tx, ctx: EmploymentContext): Promise<SQL> {
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  const identity = await managerIdentity(tx, { ...ctx, asOf });
  if (!identity.active) throw new AppError('FORBIDDEN', '需要经理自助身份');
  const orgs = `{${identity.orgIds.join(',')}}`;
  // Q-M0-71：先按负责组织过滤，再分页。历史可见不产生候选资格。每人至多两行：current 取当前生效主职，
  // pending 取命中的待入职记录；两行各自按该记录计算部门范围、人员类型、状态与展示（PR #93 首审 P2-2）。
  // F-022（Q-M0-76 / Q-M0-99）：在岗 = 当前生效主职版本人员状态 ∈ {试用, 正式}；试用中 = 人员状态为试用（不看试用期日期）；
  // 待入职 = 未删除的新增 / 重聘入职记录人员状态为待入职、入职状态 ∈ {空, 正常, 延期}，不限当前记录。
  return sql`WITH latest AS (
    SELECT DISTINCT ON (p.business_id) p.* FROM employment_payload_versions p
    WHERE p.tenant_id=${ctx.tenantId} ORDER BY p.business_id,p.version_no DESC
  ), snapshots AS (
    SELECT DISTINCT ON (p.business_id) p.* FROM employment_payload_versions p
    WHERE p.tenant_id=${ctx.tenantId} AND (p.is_record_snapshot OR EXISTS (
      SELECT 1 FROM employment_records original WHERE original.tenant_id=p.tenant_id
        AND original.payload_version_id=p.id)) ORDER BY p.business_id,p.version_no DESC
  ), states AS (
    SELECT DISTINCT ON (s.business_id) s.business_id,s.state FROM employment_state_events s
    WHERE s.tenant_id=${ctx.tenantId} ORDER BY s.business_id,s.event_no DESC
  ), sources AS (
    SELECT t.employee_id,'current' AS source,r.id AS record_id,r.staff_id,r.kind,
      cs.employee_status,cs.entry_status
    FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    JOIN LATERAL employment_record_status(r.tenant_id,r.id) cs ON true
    WHERE t.tenant_id=${ctx.tenantId} AND t.valid_during @> ${asOf}::date
    UNION ALL
    SELECT e.id,'pending',pending_entry.id,pending_entry.staff_id,pending_entry.kind,
      pending_entry.employee_status,pending_entry.entry_status
    FROM employment_employees e
    JOIN LATERAL (
      SELECT pr.id,pr.staff_id,pr.kind,ps.employee_status,ps.entry_status FROM employment_records pr
      JOIN employment_timeline pt ON pt.tenant_id=pr.tenant_id AND pt.record_id=pr.id
      JOIN states s ON s.business_id=pr.id AND s.state='effective'
      JOIN LATERAL employment_record_status(pr.tenant_id,pr.id) ps ON true
      WHERE pr.tenant_id=e.tenant_id AND pr.employee_id=e.id AND pr.kind IN ('hire','rehire')
        AND ps.employee_status=1 AND COALESCE(ps.entry_status,0) IN (0,2)
      ORDER BY pt.start_date DESC,pt.sort_order DESC LIMIT 1
    ) pending_entry ON true
    WHERE e.tenant_id=${ctx.tenantId}
  ), people AS (
    SELECT e.id,e.code,COALESCE(person.name,e.name) AS name,e.revision,
      p.department_id AS "departmentId",p.post_id AS "postId",p.level_id AS "levelId",
      p.direct_manager_id AS "directManagerId",p.dotted_manager_id AS "dottedManagerId",
      COALESCE(p.employ_type,cycle.employ_type,'internal') AS "employType",
      COALESCE(cycle.entry_date,p.effective_date) AS "entryDate",
      person.email,person.mobile_phone AS "mobilePhone",
      src.employee_status::integer AS "employeeStatus",src.entry_status::integer AS "entryStatus",
      (src.source='current' AND src.employee_status IN (2,3)) AS active,
      (src.source='current' AND src.employee_status=2) AS probation,
      (src.source='pending') AS pending,
      EXISTS (SELECT 1 FROM latest l JOIN states s ON s.business_id=l.business_id
        WHERE l.employee_id=e.id AND l.kind='leave' AND s.state<>'deleted') AS leaving,
      CASE WHEN src.source='pending' THEN 'pending'
        WHEN src.kind IN ('leave','retirement') THEN 'leaving' ELSE 'active' END AS category,
      src.source
    FROM sources src
    JOIN employment_employees e ON e.tenant_id=${ctx.tenantId} AND e.id=src.employee_id
    JOIN snapshots p ON p.business_id=src.record_id
    LEFT JOIN employment_cycles cycle ON cycle.tenant_id=e.tenant_id AND cycle.id=src.staff_id
    LEFT JOIN LATERAL (SELECT name,email,mobile_phone FROM personnel_employee_versions
      WHERE tenant_id=e.tenant_id AND employee_id=e.id ORDER BY revision DESC LIMIT 1) person ON true
    WHERE e.id<>${identity.employeeId}::uuid
      AND COALESCE(p.employ_type,cycle.employ_type,'internal') IN ('internal','intern')
      AND p.department_id=ANY(${orgs}::uuid[])
      AND ${ctx.scope ? scopeSql(ctx.scope, { org: sql`p.department_id` }) : sql`false`}
  )`;
}

export async function readManagerTeam(
  tx: Tx,
  ctx: EmploymentContext,
  page: PageQuery,
  options: {
    search?: string;
    category?: string;
    candidates?: boolean;
    emailSearch?: boolean;
    nameSearch?: boolean;
    codeSearch?: boolean;
  },
) {
  const query = await managerTeamQuery(tx, ctx);
  const [counts] = scopeRows<{ active: number; probation: number; intern: number; pending: number; leaving: number }>(
    await tx.execute(sql`${query} SELECT
      count(*) FILTER (WHERE active)::integer AS active,
      count(*) FILTER (WHERE probation)::integer AS probation,
      count(*) FILTER (WHERE active AND "employType"='intern')::integer AS intern,
      count(*) FILTER (WHERE pending)::integer AS pending,
      count(*) FILTER (WHERE leaving AND source='current')::integer AS leaving FROM people`),
  );
  const search = options.search?.trim() ?? '';
  const filter = search
    ? sql`AND ((${options.nameSearch !== false} AND name ILIKE ${`%${search}%`})
      OR (${options.codeSearch !== false} AND code ILIKE ${`%${search}%`})
    ${options.emailSearch ? sql`OR email ILIKE ${`%${search}%`}` : sql``})`
    : sql``;
  // 计数与列表共用同一谓词（Q-M0-76）；试用只看人员状态，不按日期推断（F-022）。
  const categories: Record<string, SQL> = {
    active: sql`active`,
    probation: sql`probation`,
    intern: sql`active AND "employType"='intern'`,
    pending: sql`pending`,
    leaving: sql`leaving AND source='current'`,
  };
  const items =
    options.candidates && !search
      ? []
      : scopeRows<Record<string, unknown>>(
          await tx.execute(sql`
    ${query} SELECT * FROM (SELECT DISTINCT ON (id) * FROM people WHERE true
    ${options.candidates ? sql`AND active` : sql``}
    ${options.category ? sql`AND (${categories[options.category] ?? sql`false`})` : sql``}
    ${filter} ORDER BY id,(source='pending')) people ORDER BY code,id LIMIT ${page.limit} OFFSET ${page.offset}
  `),
        );
  return {
    items,
    counts: {
      active: 0,
      probation: 0,
      intern: 0,
      pending: 0,
      leaving: 0,
      ...counts,
    },
  };
}

/** 仅装饰已经按字段权限裁剪后的行；隐藏字段不会通过显示名侧信道重新出现。 */
export async function managerRowLabels(tx: Tx, ctx: EmploymentContext, items: Record<string, unknown>[]) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const refs = [
    ...new Set(
      items.flatMap((row) =>
        ['departmentId', 'postId', 'levelId', 'directManagerId', 'dottedManagerId'].flatMap((key) =>
          typeof row[key] === 'string' ? [row[key] as string] : [],
        ),
      ),
    ),
  ];
  const ids = `{${refs.join(',')}}`;
  const names = scopeRows<{ id: string; name: string }>(
    await tx.execute(sql`
    SELECT id,name FROM (
      SELECT DISTINCT ON (org_id) org_id AS id,name FROM org_versions
      WHERE tenant_id=${ctx.tenantId} AND org_id=ANY(${ids}::uuid[]) AND start_date<=${today}::date
      ORDER BY org_id,start_date DESC,version_no DESC
    ) orgs UNION ALL
    SELECT id,name FROM (
      SELECT DISTINCT ON (object_id) object_id AS id,name FROM job_post_versions
      WHERE tenant_id=${ctx.tenantId} AND object_id=ANY(${ids}::uuid[]) AND start_date<=${today}::date
      ORDER BY object_id,start_date DESC,version_no DESC
    ) posts UNION ALL
    SELECT id,name FROM (
      SELECT DISTINCT ON (object_id) object_id AS id,name FROM job_level_versions
      WHERE tenant_id=${ctx.tenantId} AND object_id=ANY(${ids}::uuid[]) AND start_date<=${today}::date
      ORDER BY object_id,start_date DESC,version_no DESC
    ) levels UNION ALL
    SELECT e.id,COALESCE(p.name,e.name) AS name FROM employment_employees e
    LEFT JOIN LATERAL (SELECT name FROM personnel_employee_versions WHERE tenant_id=e.tenant_id
      AND employee_id=e.id ORDER BY revision DESC LIMIT 1) p ON true
    WHERE e.tenant_id=${ctx.tenantId} AND e.id=ANY(${ids}::uuid[])
  `),
  );
  const byId = new Map(names.map((row) => [row.id, row.name]));
  return items.map((row) => ({
    ...row,
    display: Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === 'string' && byId.has(value) ? byId.get(value)! : value,
      ]),
    ),
    ...(typeof row.entryDate === 'string'
      ? {
          tenure: Math.max(
            0,
            Number(today.slice(0, 4)) -
              Number(row.entryDate.slice(0, 4)) -
              (today.slice(5) < row.entryDate.slice(5) ? 1 : 0),
          ),
        }
      : {}),
  }));
}
