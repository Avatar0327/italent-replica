/**
 * 人员流动分析看板（B50）与流动情况报表（B54）的只读路由（R2 BE-13b，规格 35“补充：BE-13…”、“流动情况各报表的算法”）：
 * - GET /api/tenant/analytics/hr-movement?asOf=&departmentId=：6.25～6.32、3.1.36（近 12 个月相对 asOf）；
 * - GET …/hr-movement/components/:code?group=&page=&pageSize=：构成数字（或某个分组）的人员明细，分页；
 * - GET …/hr-movement/reports/:report?asOf=&year=&month=&departmentId=&parentId=：六个页签的行 × 列。
 * 看板对象 TenantBase.HrMovement、报表对象 TenantBase.HrMovementReport，各自的查看权与数据范围；只读，不写台账 / 审计。
 * 下载归前端（DEC-708），这里没有导出接口。
 */
import { withTenant } from '@italent/db';
import {
  HR_MOVEMENT_COMPONENTS,
  HR_MOVEMENT_OBJECT,
  HR_MOVEMENT_REPORT_OBJECT,
  HR_MOVEMENT_REPORTS,
  movementMonths,
} from '@italent/domain';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery } from '../job/context.js';
import { objectContext } from '../permission/module-route-access.js';
import { registerPersonScopedObject } from '../permission/scope-resolver.js';
import { analyticsScope } from './hr-dashboard-routes.js';
import { loadMovement } from './hr-movement.js';
import { filterMovement, movementComponents, movementMembers, type MovementLookup } from './hr-movement-board.js';
import { movementReport, reportWindow, type ReportPeriod } from './hr-movement-report.js';
import { jobDictionary, orgTree } from './hr-structure.js';
import { groupQuery, uuidQuery } from './hr-structure-routes.js';

export const HR_MOVEMENT_BASE = '/api/tenant/analytics/hr-movement';

// 人员类统计按员工归属裁剪（与人事看板同口径，AC-HA-05）
registerPersonScopedObject(HR_MOVEMENT_OBJECT);
registerPersonScopedObject(HR_MOVEMENT_REPORT_OBJECT);

type Analytics = Awaited<ReturnType<typeof analyticsScope>>;

async function boardContext(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const base = await objectContext(c, deps, HR_MOVEMENT_OBJECT, 'view');
  return analyticsScope(c, deps, base, HR_MOVEMENT_OBJECT);
}
async function reportContext(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const base = await objectContext(c, deps, HR_MOVEMENT_REPORT_OBJECT, 'view');
  return analyticsScope(c, deps, base, HR_MOVEMENT_REPORT_OBJECT);
}

/** 近 12 个月的行集与组织树；部门筛选（含下级）先于一切计算。 */
function loadBoard(deps: TenantRouteDeps, ctx: Analytics, departmentId?: string): Promise<MovementLookup> {
  const { base, scope, asOf } = ctx;
  const months = movementMonths(asOf);
  const window = { days: months.flatMap((m) => [m.start, m.end]), from: months[0]!.start, to: asOf };
  return withTenant(deps.db, base.tenantId, async (tx) => {
    const tree = await orgTree(tx, base.tenantId, asOf);
    const data = await loadMovement(tx, { tenantId: base.tenantId, asOf, scope }, window);
    return { months, tree, data: filterMovement(data, tree, departmentId) };
  });
}

const integer = (raw: string | undefined, name: string, min: number, max: number) => {
  if (raw === undefined) return undefined;
  const value = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= min && value <= max)) throw new AppError('VALIDATION_FAILED', `${name} 必须是 ${min}～${max} 的整数`);
  return value;
};

/** 年份默认 asOf 所在年，不得晚于它；月份（各机构页签）默认 asOf 所在月（往年为 12 月），不得晚于 asOf。 */
function periodOf(c: Context, asOf: string): ReportPeriod {
  const thisYear = Number(asOf.slice(0, 4));
  const year = integer(c.req.query('year'), 'year', 1900, thisYear) ?? thisYear;
  const last = year === thisYear ? Number(asOf.slice(5, 7)) : 12;
  return { year, month: integer(c.req.query('month'), 'month', 1, last) ?? last, asOf };
}

export function registerHrMovementRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(HR_MOVEMENT_BASE, async (c) => {
    const ctx = await boardContext(c, deps);
    const lookup = await loadBoard(deps, ctx, uuidQuery(c, 'departmentId'));
    return c.json({
      asOf: ctx.asOf,
      hasDataPermission: ctx.scope.hasDataPermission,
      components: movementComponents(lookup),
    });
  });

  router.get(`${HR_MOVEMENT_BASE}/components/:code`, async (c) => {
    const ctx = await boardContext(c, deps);
    const component = HR_MOVEMENT_COMPONENTS.find((item) => item.code === c.req.param('code'));
    if (!component || component.kind === 'unavailable') throw new AppError('NOT_FOUND', '组件不存在或没有数据源');
    const group = groupQuery(c);
    const departmentId = uuidQuery(c, 'departmentId');
    const page = pageQuery(c);
    const members = movementMembers(component.code, await loadBoard(deps, ctx, departmentId), group);
    if (!members) throw new AppError('VALIDATION_FAILED', '按月统计的组件须指定 group（月份）');
    return c.json({
      asOf: ctx.asOf,
      ...component,
      group: group ?? null,
      total: members.length,
      items: members
        .slice(page.offset, page.offset + page.limit)
        .map((m) => ({ id: m.employeeId, employeeId: m.employeeId, organizationId: m.departmentId })),
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope.hasDataPermission,
    });
  });

  router.get(`${HR_MOVEMENT_BASE}/reports/:report`, async (c) => {
    const ctx = await reportContext(c, deps);
    const report = HR_MOVEMENT_REPORTS.find((item) => item.code === c.req.param('report'));
    if (!report) throw new AppError('NOT_FOUND', '报表不存在');
    const period = periodOf(c, ctx.asOf);
    const departmentId = uuidQuery(c, 'departmentId');
    const parentId = uuidQuery(c, 'parentId');
    const head = {
      asOf: ctx.asOf,
      report: report.code,
      name: report.name,
      kind: report.kind,
      year: period.year,
      month: report.code === 'institution' ? period.month : null,
      hasDataPermission: ctx.scope.hasDataPermission,
    };
    if (report.kind === 'unavailable') return c.json({ ...head, tables: null });
    const { base, scope, asOf } = ctx;
    const tables = await withTenant(deps.db, base.tenantId, async (tx) => {
      const tree = await orgTree(tx, base.tenantId, asOf);
      const sequences = await jobDictionary(tx, base.tenantId, asOf, 'sequence');
      const window = reportWindow(report.code, period);
      const data = await loadMovement(tx, { tenantId: base.tenantId, asOf, scope }, window);
      const lookup = { tree, sequences, data: filterMovement(data, tree, departmentId), parentId };
      return movementReport(report.code, period, lookup);
    });
    return c.json({ ...head, tables });
  });
}
