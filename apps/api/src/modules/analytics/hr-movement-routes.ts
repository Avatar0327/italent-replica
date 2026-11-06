/**
 * 人员流动分析看板（B50）与流动情况报表（B54）的路由（R2 BE-13b，规格 35“补充：BE-13…”、“流动情况各报表的算法”）：
 * - GET /api/tenant/analytics/hr-movement?asOf=&departmentId=：6.25～6.32、3.1.36（近 12 个月相对 asOf）；
 * - GET …/hr-movement/components/:code?group=&page=&pageSize=：构成数字（或某个分组）的人员明细，分页；
 * - GET …/hr-movement/reports/:report?asOf=&year=&month=&departmentId=&parentId=：六个页签的行 × 列。
 * - GET …/hr-movement/reports/:report/export?<页面当前筛选>&mode=data|formula：各月 / 各机构两个页签的 xlsx 下载
 *   （F-482，DEC-803②、DEC-809；其余页签不导出）。
 * 看板对象 TenantBase.HrMovement、报表对象 TenantBase.HrMovementReport，各自的查看权与数据范围。看板、明细和报表查询只读，
 * 不写台账 / 审计；导出沿用报表对象的查看权与数据范围（能看就能导出），每次成功导出写一条对象操作日志（原站未测，复刻口径）。
 */
import { withTenant } from '@italent/db';
import {
  HR_MOVEMENT_COMPONENTS,
  HR_MOVEMENT_OBJECT,
  HR_MOVEMENT_REPORT_OBJECT,
  HR_MOVEMENT_REPORTS,
  movementMonths,
  type HrMovementReportCode,
} from '@italent/domain';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import { exportStatReport, exportMode } from './stat-report-export.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery } from '../job/context.js';
import { objectContext } from '../permission/module-route-access.js';
import { registerPersonScopedObject } from '../permission/scope-resolver.js';
import { analyticsScope } from './hr-dashboard-routes.js';
import { loadEstablishment, loadExitDictionaries, loadMovement, loadSnapshots } from './hr-movement.js';
import {
  filterEstablishment,
  filterMovement,
  movementComponents,
  movementMembers,
  type MovementLookup,
} from './hr-movement-board.js';
import { movementReport, reportWindow, type ReportPeriod } from './hr-movement-report.js';
import { institutionSheet, monthlySheet } from './stat-report-layout.js';
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

/**
 * 近 12 个月的行集、组织树与编制；部门筛选（含下级）先于一切计算。asOf 在 0001 年时近 12 个月早于公元 1 年，
 * 算不了，报 400（审查 P2-6）。离职按离职生效日归月（B50，DEC-729）。编制只有看板与 3.1.36 明细加载
 * （withEstablishment），其余组件明细不读编制，编制数据异常也不影响它们。
 */
function loadBoard(
  deps: TenantRouteDeps,
  ctx: Analytics,
  departmentId: string | undefined,
  withEstablishment: boolean,
): Promise<MovementLookup> {
  const { base, scope, asOf } = ctx;
  const months = movementMonths(asOf);
  if (!months) throw new AppError('VALIDATION_FAILED', 'asOf 过早，近 12 个月超出可统计的日期范围');
  const days = months.flatMap((m) => [m.start, m.end]);
  const window = { days, from: months[0]!.start, to: asOf, exitDating: 'effectiveDate' as const };
  return withTenant(deps.db, base.tenantId, async (tx) => {
    const tree = await orgTree(tx, base.tenantId, asOf);
    const data = await loadMovement(tx, { tenantId: base.tenantId, asOf, scope }, window);
    const establishment = withEstablishment ? await loadEstablishment(tx, { ...base, scope }, asOf) : [];
    return {
      months,
      tree,
      data: filterMovement(data, tree, departmentId),
      establishment: filterEstablishment(establishment, tree, departmentId),
    };
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

const EXPORTABLE = HR_MOVEMENT_REPORTS.filter((item) => item.code === 'monthly' || item.code === 'institution');

/** 一个页签的表格（页面接口与导出共用，数据范围、部门筛选、组织树都在这里一次裁好）。 */
function reportTables(
  deps: TenantRouteDeps,
  ctx: Analytics,
  code: HrMovementReportCode,
  period: ReportPeriod,
  departmentId: string | undefined,
  parentId: string | undefined,
) {
  const { base, scope, asOf } = ctx;
  return withTenant(deps.db, base.tenantId, async (tx) => {
    const a = { tenantId: base.tenantId, asOf, scope };
    const tree = await orgTree(tx, base.tenantId, asOf);
    const sequences = await jobDictionary(tx, base.tenantId, asOf, 'sequence');
    const window = reportWindow(code, period);
    // 组织编制页签只要年度取数日（年底与 asOf 较早者）的编制与实有人员，不加载整年流动数据
    const onEstablishment = code === 'establishment';
    const data = onEstablishment ? await loadSnapshots(tx, a, window.days) : await loadMovement(tx, a, window);
    const establishment = onEstablishment ? await loadEstablishment(tx, { ...base, scope }, window.to) : [];
    return movementReport(code, period, {
      tree,
      sequences,
      exitDictionaries: code === 'outflow' ? await loadExitDictionaries(tx, base.tenantId) : { types: [], reasons: [] },
      data: filterMovement(data, tree, departmentId),
      establishment: filterEstablishment(establishment, tree, departmentId),
      parentId,
    });
  });
}

export function registerHrMovementRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(HR_MOVEMENT_BASE, async (c) => {
    const ctx = await boardContext(c, deps);
    const lookup = await loadBoard(deps, ctx, uuidQuery(c, 'departmentId'), true);
    return c.json({
      asOf: ctx.asOf,
      hasDataPermission: ctx.scope.hasDataPermission,
      components: movementComponents(lookup),
    });
  });

  router.get(`${HR_MOVEMENT_BASE}/components/:code`, async (c) => {
    const ctx = await boardContext(c, deps);
    const component = HR_MOVEMENT_COMPONENTS.find((item) => item.code === c.req.param('code'));
    if (!component) throw new AppError('NOT_FOUND', '组件不存在');
    const group = groupQuery(c);
    const departmentId = uuidQuery(c, 'departmentId');
    const page = pageQuery(c);
    const lookup = await loadBoard(deps, ctx, departmentId, component.code === '3.1.36');
    const members = movementMembers(component.code, lookup, group);
    if (!members) throw new AppError('VALIDATION_FAILED', '按月或按编制对象统计的组件须指定 group（月份或编制对象）');
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
    const tables = await reportTables(deps, ctx, report.code, period, departmentId, parentId);
    return c.json({ ...head, tables });
  });

  // 导出：与页面报表接口同一份数据与裁剪，只多一层 xlsx 排版（F-482）
  router.get(`${HR_MOVEMENT_BASE}/reports/:report/export`, async (c) => {
    const ctx = await reportContext(c, deps);
    const report = EXPORTABLE.find((item) => item.code === c.req.param('report'));
    if (!report) throw new AppError('NOT_FOUND', '该报表没有导出');
    const mode = exportMode(c);
    const period = periodOf(c, ctx.asOf);
    const departmentId = uuidQuery(c, 'departmentId');
    const [table] = await reportTables(deps, ctx, report.code, period, departmentId, undefined);
    const rows = table!.rows.map((row) => ({ label: row.label, cells: row.cells }));
    return exportStatReport(c, deps, ctx.base, {
      object: HR_MOVEMENT_REPORT_OBJECT,
      reportCode: report.code,
      fileName: `${report.name}.xlsx`,
      mode,
      filter:
        report.code === 'institution'
          ? { asOf: ctx.asOf, year: period.year, month: period.month, departmentId: departmentId ?? null }
          : { asOf: ctx.asOf, year: period.year, departmentId: departmentId ?? null },
      layout: (stamp) =>
        report.code === 'monthly'
          ? monthlySheet(period.year, rows, stamp)
          : institutionSheet({ year: period.year, month: period.month! }, rows, stamp),
    });
  });
}
