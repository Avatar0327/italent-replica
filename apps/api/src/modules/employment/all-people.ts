/**
 * F-474-4c（DEC-776 / DEC-833 / DEC-836）：全部人员列表（原站“组织员工 → 人员信息 → 全部人员”，规格 codex-R1bd §2.3）。
 * 只读集合接口，读取沿用时点花名册的同一条查询（roster-query：personScope 先于分页，total 与本页同一谓词）：
 * - 入口权 = 任职记录对象（TenantBase.EmploymentRecord）的查看权，不再依赖人事分析；不新增对象 / 字段编码；
 * - 数据范围与人员侧字段权沿用员工档案对象，任职侧列按任职记录对象的字段权，无权的整列缺席，用无权字段筛选 403；
 * - 缺省人员状态 = 试用 + 正式（原站默认），可多选；不限雇佣关系；只有主职任职类型；取值为今天（租户时区）。
 * 放在 employment 目录而不是 hr-analysis，是因为它的页面与菜单属于组织员工，而不是人事分析。
 */
import { withTenant } from '@italent/db';
import {
  ALL_PEOPLE_COLUMNS,
  ALL_PEOPLE_DEFAULT_STATUSES,
  ALL_PEOPLE_EMPLOY_TYPES,
  ALL_PEOPLE_SERVICE_TYPES,
  EMPLOYEE_STATUS_CODES,
  tenantLocalDate,
} from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { allPeopleAccess, requireFilterField, type RosterAccess } from '../hr-analysis/roster-access.js';
import { countRoster, listRoster, trimRosterRow, type RosterFilter } from '../hr-analysis/roster-query.js';
import { pageQuery } from './context.js';
import { normalizedUuid } from './fields.js';

const PATH = '/all-people';
const text = z.string().trim().min(1).max(100);
const query = z.strictObject({
  name: text.optional(),
  email: text.optional(),
  employeeId: normalizedUuid.optional(),
  employmentForm: text.optional(),
  employType: z.enum(ALL_PEOPLE_EMPLOY_TYPES).optional(),
  // 逗号分隔的人员状态码，可多选
  employeeStatus: z
    .string()
    .regex(/^\d+(,\d+)*$/)
    .optional(),
  serviceType: z.enum(ALL_PEOPLE_SERVICE_TYPES).optional(),
  page: z.unknown().optional(),
  pageSize: z.unknown().optional(),
});

function parseQuery(c: Context<TenantEnv>) {
  const result = query.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!result.success) throw new AppError('VALIDATION_FAILED', '全部人员查询参数不合法');
  const { employeeStatus, serviceType, page: _page, pageSize: _pageSize, ...filter } = result.data;
  const statuses = employeeStatus ? [...new Set(employeeStatus.split(',').map(Number))] : undefined;
  if (statuses?.some((code) => !EMPLOYEE_STATUS_CODES.includes(code as never)))
    throw new AppError('VALIDATION_FAILED', '人员状态取值不合法');
  return { filter: filter as RosterFilter, statuses, serviceType };
}

/** 筛选字段对应的字段权：姓名 / 邮箱 / 员工 / 人员状态属员工档案，雇佣关系 / 用工形式 / 任职类型属任职记录。 */
function requireFilterRights(rights: RosterAccess, parsed: ReturnType<typeof parseQuery>) {
  const { filter, statuses, serviceType } = parsed;
  if (filter.name || filter.employeeId) requireFilterField(rights, 'person', 'name');
  if (filter.email) requireFilterField(rights, 'person', 'email');
  if (statuses) requireFilterField(rights, 'person', 'employeeStatus');
  if (filter.employType) requireFilterField(rights, 'record', 'employType');
  if (filter.employmentForm) requireFilterField(rights, 'record', 'employmentForm');
  if (serviceType) requireFilterField(rights, 'record', 'serviceType');
}

export function registerAllPeople(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(PATH, async (c) => {
    const parsed = parseQuery(c);
    const rights = await allPeopleAccess(c, deps, ALL_PEOPLE_COLUMNS);
    requireFilterRights(rights, parsed);
    const page = pageQuery(c);
    const asOf = tenantLocalDate(rights.ctx.now, rights.ctx.timezone);
    const base = { statuses: parsed.statuses ?? ALL_PEOPLE_DEFAULT_STATUSES };
    const { total, items } = await withTenant(deps.db, rights.ctx.tenantId, async (tx) => ({
      total: await countRoster(tx, rights.ctx, asOf, parsed.filter, base),
      items: await listRoster(tx, rights.ctx, asOf, parsed.filter, page, base),
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
}
