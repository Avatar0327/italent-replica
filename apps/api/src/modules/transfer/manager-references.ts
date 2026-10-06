/** DEC-205：参照权限来自调动字段；只披露负责组织内可选值，不授予整个职务字典读取权。 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { EmploymentContext, PageQuery } from '../employment/types.js';
import { managerIdentity } from '../permission/manager-identity.js';
import { scopeRows } from '../permission/scope-hierarchy.js';
import { scopeSql } from '../permission/module-access.js';
import { currentPersons } from '../permission/scope-persons.js';
import { jobTables, type JobKind } from '../job/metadata.js';

export const managerReferenceFields = [
  'departmentId',
  'positionId',
  'postId',
  'levelId',
  'gradeId',
  'sequenceId',
  'professionalLineId',
  'directManagerId',
  'dottedManagerId',
  'addedSubordinateIds',
] as const;
export interface ManagerReferenceQuery {
  effectiveDate: string;
  departmentId?: string | null;
  postId?: string | null;
  name?: string;
  id?: string;
}
const jobKinds: Record<string, JobKind> = {
  positionId: 'positions',
  postId: 'posts',
  levelId: 'levels',
  gradeId: 'grades',
  sequenceId: 'sequences',
  professionalLineId: 'professional-lines',
};
function effectiveJobs(tenantId: string, kind: JobKind, asOf: string) {
  return sql`SELECT * FROM (SELECT DISTINCT ON (object_id) * FROM ${sql.identifier(jobTables(kind).versionTable)}
    WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date
    ORDER BY object_id,start_date DESC,version_no DESC) v WHERE enabled AND stop_date>=${asOf}::date`;
}
export async function managerReferenceQuery(tx: Tx, ctx: EmploymentContext, q: ManagerReferenceQuery) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const identity = await managerIdentity(tx, { ...ctx, asOf: today });
  if (!identity.active) throw new AppError('FORBIDDEN', '需要经理自助身份');
  const orgs = `{${identity.orgIds.join(',')}}`;
  return sql`WITH organizations AS (
    SELECT * FROM (SELECT DISTINCT ON (org_id) org_id,name,enabled,stop_date FROM org_versions
      WHERE tenant_id=${ctx.tenantId} AND start_date<=${q.effectiveDate}::date
      ORDER BY org_id,start_date DESC,version_no DESC) o
    WHERE enabled AND stop_date>=${q.effectiveDate}::date AND org_id=ANY(${orgs}::uuid[])
      AND ${ctx.scope ? scopeSql(ctx.scope, { org: sql`o.org_id` }) : sql`false`}
  ), positions AS (
    SELECT p.* FROM (${effectiveJobs(ctx.tenantId, 'positions', q.effectiveDate)}) p
    JOIN organizations o ON o.org_id=p.org_id
    ${q.departmentId ? sql`WHERE p.org_id=${q.departmentId}::uuid` : sql``}
  ), posts AS (
    SELECT p.* FROM (${effectiveJobs(ctx.tenantId, 'posts', q.effectiveDate)}) p
    WHERE p.object_id IN (SELECT post_id FROM positions)
  )`;
}

export async function readManagerReferences(
  tx: Tx,
  ctx: EmploymentContext,
  field: string,
  q: ManagerReferenceQuery,
  page: Pick<PageQuery, 'limit' | 'offset'>,
): Promise<{ id: string; name: string }[]> {
  const base = await managerReferenceQuery(tx, ctx, q);
  if (q.departmentId) {
    const allowed = scopeRows(
      await tx.execute(sql`${base} SELECT 1 FROM organizations WHERE org_id=${q.departmentId}::uuid`),
    );
    if (!allowed.length) throw new AppError('FORBIDDEN', '调动参照不在可选范围');
  }
  if (q.postId) {
    const allowed = scopeRows(await tx.execute(sql`${base} SELECT 1 FROM posts WHERE object_id=${q.postId}::uuid`));
    if (!allowed.length) throw new AppError('FORBIDDEN', '调动参照不在可选范围');
  }
  let choices: SQL;
  if (field === 'departmentId') choices = sql`SELECT org_id AS id,name FROM organizations`;
  else if (['directManagerId', 'dottedManagerId', 'addedSubordinateIds'].includes(field)) {
    // 同一负责组织边界内的当前在职员工；不返回邮箱、员工档案或字典的其他字段。
    choices = sql`SELECT e.id,e.name FROM (${currentPersons(ctx.tenantId, tenantLocalDate(ctx.now, ctx.timezone))}) p
      JOIN organizations o ON o.org_id=p.department_id
      JOIN employment_employees e ON e.tenant_id=${ctx.tenantId} AND e.id=p.employee_id
      WHERE p.kind NOT IN ('leave','retirement') AND p.service_type='primary'`;
  } else if (field === 'positionId' || field === 'postId') {
    choices = sql`SELECT object_id AS id,name FROM ${sql.identifier(field === 'positionId' ? 'positions' : 'posts')}`;
  } else if (field === 'sequenceId' || field === 'professionalLineId') {
    const column = sql.identifier(field === 'sequenceId' ? 'sequence_id' : 'professional_line_id');
    choices = sql`SELECT object_id AS id,name FROM (${effectiveJobs(ctx.tenantId, jobKinds[field]!, q.effectiveDate)}) v
      WHERE object_id IN (SELECT ${column} FROM positions UNION SELECT ${column} FROM posts
        ${q.postId ? sql`WHERE object_id=${q.postId}::uuid` : sql``})`;
  } else if (field === 'levelId' || field === 'gradeId') {
    const kind = field === 'levelId' ? 'levels' : 'grades';
    const column = sql.identifier(field === 'levelId' ? 'level' : 'grade');
    const min = sql.identifier(field === 'levelId' ? 'min_level_id' : 'min_grade_id');
    const max = sql.identifier(field === 'levelId' ? 'max_level_id' : 'max_grade_id');
    const versions = effectiveJobs(ctx.tenantId, kind, q.effectiveDate);
    // 没有配置区间的职务不能使选择器退化成全租户字典。
    choices = sql`SELECT v.object_id AS id,v.name FROM (${versions}) v WHERE EXISTS (
      SELECT 1 FROM posts p LEFT JOIN (${versions}) lo ON lo.object_id=p.${min}
      LEFT JOIN (${versions}) hi ON hi.object_id=p.${max}
      WHERE (lo.object_id IS NOT NULL OR hi.object_id IS NOT NULL)
        AND (p.${min} IS NULL OR v.${column}>=lo.${column})
        AND (p.${max} IS NULL OR v.${column}<=hi.${column})
        ${field === 'levelId' ? sql`AND (p.level_type_id IS NULL OR p.level_type_id=v.level_type_id)` : sql``}
        ${q.postId ? sql`AND p.object_id=${q.postId}::uuid` : sql``}
    )`;
  } else throw new AppError('FORBIDDEN', '无权查看调动参照');
  return scopeRows(
    await tx.execute(sql`${base} SELECT id,name FROM (${choices}) choices WHERE true
    ${q.name ? sql`AND name ILIKE ${`%${q.name}%`}` : sql``}
    ${q.id ? sql`AND id=${q.id}::uuid` : sql``}
    ORDER BY name,id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
}

/** 提交只校验显式变更；只读继承不要求历史值仍在候选中。与选择器使用相同谓词。 */
export async function requireManagerReferenceValues(
  tx: Tx,
  ctx: EmploymentContext,
  effectiveDate: string,
  fields: Readonly<Record<string, unknown>>,
) {
  const q: ManagerReferenceQuery = {
    effectiveDate,
    departmentId: typeof fields.departmentId === 'string' ? fields.departmentId : undefined,
    postId: typeof fields.postId === 'string' ? fields.postId : undefined,
  };
  for (const field of managerReferenceFields) {
    const value = fields[field];
    const ids = Array.isArray(value) ? value : [value];
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const items = await readManagerReferences(tx, ctx, field, { ...q, id }, { limit: 1, offset: 0 });
      if (!items.length) throw new AppError('FORBIDDEN', '调动参照不在可选范围');
    }
  }
}
