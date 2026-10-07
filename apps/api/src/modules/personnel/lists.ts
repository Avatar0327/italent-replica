import { sortRankColumns } from './sorting.js';
import { sql, type Tx } from '@italent/db';
import {
  isEmployeeStatusCode,
  isEntryStatusCode,
  SUBSET_EMPLOYEE_ATTRIBUTES,
  PERSONNEL_OBJECT,
  SUBSETS,
  type SubsetKind,
} from '@italent/domain';
import type { Context } from 'hono';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import { personScope, trimWithFields, type AccessContext } from './access.js';
import { employeeAttributes, employeeDto, employeeJoins } from './employee-read.js';
import { camel, rows, type Row } from './store.js';

const sortColumns: Record<string, SQL> = {
  code: sql`e.code`,
  orderCode: sql`person_rank.order_code`,
  organizationSortNumber: sql`org_rank.sort_number`,
  postSortNumber: sql`post_rank.sort_number`,
  employeeName: sql`COALESCE(v.name,e.name)`,
  entryDate: sql`r.entry_date`,
  firstEntryDate: sql`cycles.first_entry_date`,
  latestEntryDate: sql`cycles.latest_entry_date`,
  lastWorkDate: sql`r.last_work_date`,
  levelSortNumber: sql`jl.level`,
  gradeSortNumber: sql`jg.grade`,
  positionSortNumber: sql`jp.display_order`,
  // F-022：当前生效主职版本的人员状态 / 入职状态（编码）
  employeeStatus: sql`r.current_employee_status`,
  entryStatus: sql`r.current_entry_status`,
};
/** F-022：状态筛选按原站编码校验，非法编码 400（与任职员工列表一致）。 */
const STATUS_FILTERS: Readonly<Record<string, (value: number) => boolean>> = {
  employeeStatus: isEmployeeStatusCode,
  entryStatus: isEntryStatusCode,
};

export async function listOptions(c: Context, deps: TenantRouteDeps, ctx: AccessContext) {
  const sortBy = c.req.query('sortBy');
  const direction = c.req.query('direction') ?? 'asc';
  if (!['asc', 'desc'].includes(direction) || (sortBy && !sortColumns[sortBy]))
    throw new AppError('VALIDATION_FAILED', '排序参数不合法');
  const filters: SQL[] = [];
  const viewable = await getModuleViewableFields(deps, ctx, PERSONNEL_OBJECT);
  const subsetFields = await getModuleViewableFields(deps, ctx, ctx.objectCode);
  for (const key of Object.keys(sortColumns)) {
    const value = c.req.query(key);
    if (sortBy === key || value !== undefined) {
      const field = key === 'employeeName' ? 'name' : key;
      const subsetField = Object.entries(SUBSET_EMPLOYEE_ATTRIBUTES).find(([, v]) => v === field)?.[0] ?? field;
      if (
        (viewable && !viewable.has(field)) ||
        (ctx.objectCode !== PERSONNEL_OBJECT && subsetFields && !subsetFields.has(subsetField))
      )
        throw new AppError('FORBIDDEN', '员工排序或筛选字段不可查看');
    }
    if (value !== undefined) {
      if (value.length > 200) throw new AppError('VALIDATION_FAILED', '筛选值过长');
      const check = STATUS_FILTERS[key];
      if (check && !(/^\d+$/.test(value) && check(Number(value))))
        throw new AppError('VALIDATION_FAILED', '人员状态或入职状态编码不合法');
      filters.push(sql`${sortColumns[key]}::text=${value}`);
    }
  }
  const order = sortBy ? sql`${sortColumns[sortBy]} ${direction === 'desc' ? sql`DESC` : sql`ASC`} NULLS LAST,` : sql``;
  return { order, filter: filters.length ? sql.join(filters, sql` AND `) : sql`true` };
}
export interface ListOptions {
  readonly order: SQL;
  readonly filter: SQL;
}
export const UNSORTED: ListOptions = { order: sql``, filter: sql`true` };
export async function listEmployees(
  tx: Tx,
  ctx: AccessContext,
  page: { limit: number; offset: number },
  options: ListOptions,
) {
  return rows(
    await tx.execute(sql`SELECT e.id,${employeeAttributes},to_jsonb(v) AS profile
    FROM employment_employees e ${employeeJoins(ctx)} WHERE e.tenant_id=${ctx.tenantId}
    AND ${personScope(ctx)} AND ${options.filter}
    ORDER BY ${options.order} person_rank.order_code ASC NULLS LAST,e.code COLLATE "C",e.id
    LIMIT ${page.limit} OFFSET ${page.offset}`),
  ).map((row) => employeeDto(row, ctx));
}
export function subsetDto(row: Row, kind: SubsetKind) {
  const result = camel(row);
  for (const field of SUBSETS[kind].fields) {
    if (field.kind === 'decimal' && result[field.code] !== null) result[field.code] = Number(result[field.code]);
  }
  return result;
}
export async function listSubsets(
  tx: Tx,
  ctx: AccessContext,
  kind: SubsetKind,
  page: { limit: number; offset: number },
  options: ListOptions,
  employeeId?: string,
) {
  return rows(
    await tx.execute(sql`SELECT s.*,e.code,u.user_id,COALESCE(v.name,e.name) AS employee_name,
      r.entry_date::text AS employee_entry_date,r.last_work_date::text AS employee_last_work_date,
      cycles.first_entry_date::text AS employee_first_entry_date,
      cycles.latest_entry_date::text AS employee_latest_entry_date,
      ${sortRankColumns},person_rank.order_code,
      jl.level AS level_sort_number,jg.grade AS grade_sort_number,
      jp.display_order AS position_sort_number
    FROM ${sql.identifier(SUBSETS[kind].table)} s JOIN employment_employees e
      ON e.tenant_id=s.tenant_id AND e.id=s.employee_id ${employeeJoins(ctx)}
    WHERE s.tenant_id=${ctx.tenantId} AND NOT s.deleted AND ${personScope(ctx, 'e', sql`s.created_by`)}
      AND ${options.filter}
    ${employeeId ? sql`AND s.employee_id=${employeeId}::uuid` : sql``}
    ORDER BY ${options.order} person_rank.order_code ASC NULLS LAST,e.code COLLATE "C",e.id,s.id
    LIMIT ${page.limit} OFFSET ${page.offset}`),
  ).map((row) => subsetDto(row, kind));
}
export async function listFieldVisibility(deps: TenantRouteDeps, ctx: AccessContext) {
  return {
    object: await getModuleViewableFields(deps, ctx, ctx.objectCode),
    employee: await getModuleViewableFields(deps, ctx, PERSONNEL_OBJECT),
  };
}
export function trimSubset(
  value: Row,
  fields: { object: ReadonlySet<string> | undefined; employee: ReadonlySet<string> | undefined },
) {
  const result = trimWithFields(value, fields.object);
  const employeeFields = fields.employee;
  if (employeeFields)
    for (const [field, employeeField] of Object.entries(SUBSET_EMPLOYEE_ATTRIBUTES)) {
      if (!employeeFields.has(employeeField)) delete result[field];
    }
  return result;
}
