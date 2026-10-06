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
  // Q-M0-71：先按当前主职（待入职取未来入职）和负责组织过滤，再分页。历史可见不产生候选资格。
  return sql`WITH latest AS (
    SELECT DISTINCT ON (p.business_id) p.* FROM employment_payload_versions p
    WHERE p.tenant_id=${ctx.tenantId} ORDER BY p.business_id,p.version_no DESC
  ), states AS (
    SELECT DISTINCT ON (s.business_id) s.business_id,s.state FROM employment_state_events s
    WHERE s.tenant_id=${ctx.tenantId} ORDER BY s.business_id,s.event_no DESC
  ), people AS (
    SELECT e.id,e.code,COALESCE(person.name,e.name) AS name,e.revision,
      p.department_id AS "departmentId",p.post_id AS "postId",p.level_id AS "levelId",
      p.direct_manager_id AS "directManagerId",p.dotted_manager_id AS "dottedManagerId",
      COALESCE(p.employ_type,cycle.employ_type) AS "employType",
      COALESCE(cycle.entry_date,p.effective_date) AS "entryDate",
      person.email,person.mobile_phone AS "mobilePhone",
      CASE WHEN t.record_id IS NULL OR r.kind IN ('leave','retirement') THEN 'pending'
        WHEN EXISTS (SELECT 1 FROM latest l JOIN states s ON s.business_id=l.business_id
          WHERE l.employee_id=e.id AND l.kind IN ('leave','retirement')
          AND s.state IN ('in_review','approved','effective')
          AND l.effective_date>=${asOf}::date) THEN 'leaving'
        WHEN COALESCE(p.employ_type,cycle.employ_type)='intern' THEN 'intern'
        ELSE 'active' END AS category
    FROM employment_employees e
    LEFT JOIN employment_timeline t ON t.tenant_id=e.tenant_id AND t.employee_id=e.id
      AND t.valid_during @> ${asOf}::date
    LEFT JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    JOIN LATERAL (
      SELECT l.* FROM latest l JOIN states s ON s.business_id=l.business_id
      WHERE l.employee_id=e.id AND (
        (l.business_id=r.id AND r.kind NOT IN ('leave','retirement')) OR
        ((r.id IS NULL OR r.kind IN ('leave','retirement'))
          AND l.kind IN ('hire','rehire','retire_rehire')
          AND l.effective_date>${asOf}::date AND s.state IN ('approved','effective')))
      ORDER BY l.effective_date,l.business_id LIMIT 1
    ) p ON true
    LEFT JOIN employment_cycles cycle ON cycle.tenant_id=e.tenant_id
      AND cycle.id=COALESCE(p.selected_staff_id,r.staff_id)
    LEFT JOIN LATERAL (SELECT name,email,mobile_phone FROM personnel_employee_versions
      WHERE tenant_id=e.tenant_id AND employee_id=e.id ORDER BY revision DESC LIMIT 1) person ON true
    WHERE e.tenant_id=${ctx.tenantId} AND e.id<>${identity.employeeId}::uuid
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
  const counts = scopeRows<{ category: string; count: number }>(
    await tx.execute(sql`
    ${query} SELECT category,count(*)::integer AS count FROM people GROUP BY category
  `),
  );
  const search = options.search?.trim() ?? '';
  const filter = search
    ? sql`AND ((${options.nameSearch !== false} AND name ILIKE ${`%${search}%`})
      OR (${options.codeSearch !== false} AND code ILIKE ${`%${search}%`})
    ${options.emailSearch ? sql`OR email ILIKE ${`%${search}%`}` : sql``})`
    : sql``;
  // TODO(需取证 #80)：现有模型无人员试用状态，不能从合同试用期推断。
  const items =
    options.candidates && !search
      ? []
      : scopeRows<Record<string, unknown>>(
          await tx.execute(sql`
    ${query} SELECT * FROM people WHERE true
    ${options.candidates ? sql`AND category<>'pending'` : sql``}
    ${options.category ? sql`AND category=${options.category}` : sql``}
    ${filter} ORDER BY code,id LIMIT ${page.limit} OFFSET ${page.offset}
  `),
        );
  return {
    items,
    counts: {
      active: 0,
      probation: null,
      intern: 0,
      pending: 0,
      leaving: 0,
      ...Object.fromEntries(counts.map((row) => [row.category, row.count])),
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
