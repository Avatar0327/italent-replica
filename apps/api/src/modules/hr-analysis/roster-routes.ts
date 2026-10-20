/**
 * 人事分析 - 员工时点花名册（BE-12a；规格 35 §2.2、AC-HA-03 / AC-HA-05）：
 * - GET /roster：asOf（缺省租户今天，可选任意历史 / 未来日期）+ 筛选 + 分页，默认按工号排序；
 * - GET /roster/export：同一查询与权限的同步 CSV（UTF-8 带 BOM），行数上限 ROSTER_EXPORT_MAX_ROWS。
 * 列表与导出共用 rosterAccess（功能权 / 数据范围 / 逐列字段权）与同一条读取语句，不导出比列表更多的行或列。
 */
import { withTenant } from '@italent/db';
import { ROSTER_EMPLOY_TYPES, ROSTER_EMPLOYEE_STATUSES, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery } from '../job/context.js';
import { assertExportable, rosterCsv } from './roster-csv.js';
import { requireFilterField, rosterAccess, type RosterAccess } from './roster-access.js';
import { countRoster, listRoster, trimRosterRow, type RosterFilter } from './roster-query.js';
import { ROSTER_EXPORT_MAX_ROWS } from '@italent/domain';

const BASE = '/api/tenant/hr-analysis/roster';
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });
const text = z.string().min(1).max(200);
const query = z.strictObject({
  asOf: isoDate.optional(),
  name: text.optional(),
  email: text.optional(),
  workDateFrom: isoDate.optional(),
  workDateTo: isoDate.optional(),
  employeeStatus: z.coerce
    .number()
    .refine((value) => ROSTER_EMPLOYEE_STATUSES.includes(value as 2 | 3))
    .optional(),
  employType: z.enum(ROSTER_EMPLOY_TYPES).optional(),
  page: z.unknown().optional(),
  pageSize: z.unknown().optional(),
});

function parseQuery(c: Context<TenantEnv>) {
  const result = query.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!result.success) throw new AppError('VALIDATION_FAILED', '花名册查询参数不合法');
  const { asOf, page: _page, pageSize: _pageSize, ...filter } = result.data;
  return { asOf, filter: filter as RosterFilter };
}

/** 筛选字段对应的字段权：姓名 / 邮箱 / 参加工作日期 / 人员状态属员工档案，雇佣关系属任职记录。 */
function requireFilterRights(rights: RosterAccess, filter: RosterFilter) {
  if (filter.name) requireFilterField(rights, 'person', 'name');
  if (filter.email) requireFilterField(rights, 'person', 'email');
  if (filter.workDateFrom || filter.workDateTo) requireFilterField(rights, 'person', 'workDate');
  if (filter.employeeStatus) requireFilterField(rights, 'person', 'employeeStatus');
  if (filter.employType) requireFilterField(rights, 'record', 'employType');
}

export function registerRosterRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(BASE, async (c) => {
    const { asOf: requested, filter } = parseQuery(c);
    const rights = await rosterAccess(c, deps, false);
    requireFilterRights(rights, filter);
    const page = pageQuery(c);
    const asOf = requested ?? tenantLocalDate(rights.ctx.now, rights.ctx.timezone);
    const { total, items } = await withTenant(deps.db, rights.ctx.tenantId, async (tx) => ({
      total: await countRoster(tx, rights.ctx, asOf, filter),
      items: await listRoster(tx, rights.ctx, asOf, filter, page),
    }));
    return c.json({
      asOf,
      items: items.map((row) => trimRosterRow(row, rights.columns)),
      columns: rights.columns.map(({ key, label }) => ({ key, label })),
      total,
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: rights.ctx.scope.hasDataPermission,
    });
  });
  router.get(`${BASE}/export`, async (c) => {
    const { asOf: requested, filter } = parseQuery(c);
    const rights = await rosterAccess(c, deps, true);
    requireFilterRights(rights, filter);
    const asOf = requested ?? tenantLocalDate(rights.ctx.now, rights.ctx.timezone);
    const items = await withTenant(deps.db, rights.ctx.tenantId, async (tx) => {
      assertExportable(await countRoster(tx, rights.ctx, asOf, filter));
      return listRoster(tx, rights.ctx, asOf, filter, { limit: ROSTER_EXPORT_MAX_ROWS, offset: 0 });
    });
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="roster-${asOf}.csv"`);
    return c.body(
      rosterCsv(
        rights.columns,
        items.map((row) => trimRosterRow(row, rights.columns)),
      ),
    );
  });
}
