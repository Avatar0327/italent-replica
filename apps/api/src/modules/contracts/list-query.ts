/**
 * 合同列表的参数解析与 SQL 拼装入口（F-128 A7）：所有视图（全部 / 有效 / 即将到期 / 过期未续签 / 入职缺失 / 审批中）
 * 共用同一份参数、同一份筛选谓词和同一份排序，不在每个视图各写一遍。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { listOrgDescendantsInTransaction } from '../org/hierarchy-reader.js';
import { currentPersons } from '../permission/scope-persons.js';
import type { OrgId } from '@italent/domain';
import type { ContractContext } from './context.js';
import { uuid } from './input.js';

export const LIST_VIEWS = ['all', 'valid', 'expiring', 'expired_unrenewed', 'missing', 'in_review'] as const;
export type ListView = (typeof LIST_VIEWS)[number];
const RECORD_STATUSES = ['valid', 'terminated', 'void'] as const;
const REQUEST_STATUSES = ['in_review', 'approved', 'returned'] as const;
/** 排序白名单：终止日、生效日、签订日、姓名、编号。 */
export const SORT_FIELDS = ['endDate', 'effectiveDate', 'signingDate', 'name', 'number'] as const;

const day = z.iso.date();
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');
const listQuerySchema = z.strictObject({
  view: z.enum(LIST_VIEWS).default('all'),
  days: z.coerce.number().int().min(1).max(3660).optional(),
  employeeId: uuid.optional(),
  keyword: z.string().trim().min(1).max(100).optional(),
  orgId: uuid.optional(),
  includeChildren: flag.optional(),
  typeId: uuid.optional(),
  companyId: uuid.optional(),
  status: z.enum([...RECORD_STATUSES, ...REQUEST_STATUSES]).optional(),
  termType: z.enum(['fixed', 'indefinite', 'task']).optional(),
  effectiveFrom: day.optional(),
  effectiveTo: day.optional(),
  endFrom: day.optional(),
  endTo: day.optional(),
  sort: z.enum(SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type ListQuery = z.infer<typeof listQuerySchema> & { days: number };

/** 解析查询串（不含 page / pageSize，它们由 pageQuery 处理）。即将到期视图必须带 days。 */
export function parseListQuery(raw: Record<string, string>): ListQuery {
  const { page: _page, pageSize: _pageSize, ...rest } = raw;
  const result = listQuerySchema.safeParse(rest);
  if (!result.success) throw new AppError('VALIDATION_FAILED', '合同列表参数不合法', result.error.issues);
  const query = result.data;
  if (query.view === 'expiring' && query.days === undefined) {
    throw new AppError('VALIDATION_FAILED', '即将到期必须给出到期天数 days');
  }
  return { ...query, days: query.days ?? 0 };
}

/**
 * 各视图实际生效的筛选：在入口统一决定，下游只认返回值，不逐个参数打补丁。
 * 入职缺失查的是“没有有效合同的员工”，没有可比较的合同日期 / 类型 / 公司 / 状态 / 期限，只认员工、关键字、组织，
 * 以及特殊含义的 typeId（缺该类型的有效合同）和按姓名排序；其余合同维度的筛选一律忽略。
 */
export function applicableQuery(query: ListQuery): ListQuery {
  if (query.view !== 'missing') return query;
  const { view, days, employeeId, keyword, orgId, includeChildren, typeId, order } = query;
  return {
    view,
    days,
    order,
    ...(employeeId ? { employeeId } : {}),
    ...(keyword ? { keyword } : {}),
    ...(orgId ? { orgId } : {}),
    ...(includeChildren !== undefined ? { includeChildren } : {}),
    ...(typeId ? { typeId } : {}),
    ...(query.sort === 'name' ? { sort: query.sort } : {}),
  };
}

/** 部门筛选的最终部门集合；includeChildren 时并入行政维度的全部下级（含停用）。 */
export async function resolveOrgIds(tx: Tx, ctx: ContractContext, query: ListQuery, today: string) {
  if (!query.orgId) return null;
  const ids = new Set<string>([query.orgId]);
  if (query.includeChildren) {
    const children = await listOrgDescendantsInTransaction(
      tx,
      { tenantId: ctx.tenantId, orgId: query.orgId as OrgId, dimension: 'admin', asOf: today },
      { includeDisabled: true },
    );
    for (const id of children) ids.add(id);
  }
  return [...ids];
}

/** 被筛选的对象在 SQL 里的列；合同与申请两侧各给一份。 */
export interface FilterColumns {
  readonly side: 'record' | 'request';
  readonly employee: SQL;
  readonly type: SQL;
  readonly company: SQL;
  readonly status: SQL;
  readonly termType: SQL;
  readonly effective: SQL;
  readonly end: SQL;
}

/** 员工姓名 / 工号子查询，供关键字筛选与按姓名排序共用。 */
const employeeName = (tenantId: string, employee: SQL) =>
  sql`(SELECT n.name FROM employment_employees n WHERE n.tenant_id=${tenantId} AND n.id=${employee})`;

/**
 * 员工、组织、类型、公司、状态、期限类型与日期区间的筛选谓词。状态按列所在侧解释：
 * 合同侧认 valid / terminated / void，申请侧认 in_review / approved / returned，不属于本侧的取值恒为假。
 */
export function filterPredicate(
  query: ListQuery,
  columns: FilterColumns,
  tenantId: string,
  today: string,
  orgIds: readonly string[] | null,
): SQL {
  const terms: SQL[] = [];
  if (query.employeeId) terms.push(sql`${columns.employee}=${query.employeeId}::uuid`);
  if (query.keyword) {
    terms.push(sql`EXISTS (SELECT 1 FROM employment_employees k WHERE k.tenant_id=${tenantId}
      AND k.id=${columns.employee} AND (strpos(lower(k.name),lower(${query.keyword}))>0
        OR strpos(lower(k.code),lower(${query.keyword}))>0))`);
  }
  if (orgIds) {
    terms.push(sql`EXISTS (SELECT 1 FROM (${currentPersons(tenantId, today)}) org_person
      WHERE org_person.employee_id=${columns.employee} AND org_person.service_type='primary'
        AND org_person.department_id=ANY(${`{${orgIds.join(',')}}`}::uuid[]))`);
  }
  if (query.typeId) terms.push(sql`${columns.type}=${query.typeId}::uuid`);
  if (query.companyId) terms.push(sql`${columns.company}=${query.companyId}::uuid`);
  if (query.status) {
    const own: readonly string[] = columns.side === 'record' ? RECORD_STATUSES : REQUEST_STATUSES;
    terms.push(own.includes(query.status) ? sql`${columns.status}=${query.status}` : sql`false`);
  }
  if (query.termType) terms.push(sql`${columns.termType}=${query.termType}`);
  if (query.effectiveFrom) terms.push(sql`${columns.effective}>=${query.effectiveFrom}::date`);
  if (query.effectiveTo) terms.push(sql`${columns.effective}<=${query.effectiveTo}::date`);
  if (query.endFrom) terms.push(sql`${columns.end}>=${query.endFrom}::date`);
  if (query.endTo) terms.push(sql`${columns.end}<=${query.endTo}::date`);
  return terms.length ? sql.join(terms, sql` AND `) : sql`true`;
}

/** 排序键在 SQL 里的列；all 视图的外层只能引用并集子查询暴露的列。 */
export interface OrderColumns {
  readonly tenantId: string;
  readonly employee: SQL;
  readonly effective: SQL;
  readonly end: SQL;
  readonly signing: SQL;
  readonly number: SQL;
  readonly id: SQL;
}

/** 未指定排序时保持现状（生效日、ID）；指定后空值排最后，并以 ID 兜底保证翻页稳定。 */
export function orderClause(query: ListQuery, columns: OrderColumns): SQL {
  if (!query.sort) return sql`${columns.effective},${columns.id}`;
  const direction = query.order === 'desc' ? sql`DESC` : sql`ASC`;
  const key = {
    endDate: columns.end,
    effectiveDate: columns.effective,
    signingDate: columns.signing,
    number: columns.number,
    name: employeeName(columns.tenantId, columns.employee),
  }[query.sort];
  return sql`${key} ${direction} NULLS LAST,${columns.id}`;
}
