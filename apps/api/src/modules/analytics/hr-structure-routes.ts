/**
 * 人员结构分析看板（B49）与员工结构两张报表（B53）的路由（R2 BE-13a，规格 35“补充：BE-13…”）：
 * - GET /api/tenant/analytics/hr-structure?asOf=&<看板筛选>：6.01～6.14 的数据（编码、名称、形态、数值 / 分组）；
 *   看板筛选 = institutionId / institutionIncludeChildren、departmentId / departmentIncludeChildren、sequenceId、
 *   employmentForm、employmentType（两个“包含下级”缺省 true）；
 * - GET …/hr-structure/components/:code?group=&page=&pageSize=：构成数字（或某个分组）的人员明细，分页；
 * - GET …/hr-structure/reports/:report?asOf=&employType=&departmentId=&departmentIncludeChildren=：
 *   一级组织 × 列的报表（字典维度按字典展开）。
 * - GET …/hr-structure/reports/quality/export?<页面当前筛选>&mode=data|formula：员工素质结构的 xlsx 下载
 *   （F-482，DEC-803②、DEC-809；岗位结构页签不导出）。
 * 看板对象 TenantBase.HrStructure、报表对象 TenantBase.HrStructureReport，各自的查看权与数据范围。看板、明细和报表查询只读，
 * 不写台账 / 审计；导出沿用报表对象的查看权与数据范围（能看就能导出），每次成功导出写一条对象操作日志（原站未测，复刻口径）。
 */
import { isUuid, withTenant, type Tx } from '@italent/db';
import {
  HR_STRUCTURE_COMPONENTS,
  HR_STRUCTURE_OBJECT,
  HR_STRUCTURE_REPORT_EMPLOY_TYPES,
  HR_STRUCTURE_REPORT_OBJECT,
  HR_STRUCTURE_REPORTS,
} from '@italent/domain';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery } from '../job/context.js';
import { objectContext } from '../permission/module-route-access.js';
import { registerPersonScopedObject } from '../permission/scope-resolver.js';
import { analyticsScope } from './hr-dashboard-routes.js';
import { jobDictionary, orgTree, structurePeople } from './hr-structure.js';
import { exportMode, exportStatReport } from './stat-report-export.js';
import { qualitySheet } from './stat-report-layout.js';
import {
  componentMembers,
  filterPeople,
  isGrouped,
  structureComponents,
  structureReport,
  type StructureFilter,
  type StructureLookup,
} from './hr-structure-board.js';

export const HR_STRUCTURE_BASE = '/api/tenant/analytics/hr-structure';

// 人员类统计按员工归属裁剪（与人事看板同口径）
registerPersonScopedObject(HR_STRUCTURE_OBJECT);
registerPersonScopedObject(HR_STRUCTURE_REPORT_OBJECT);

/** “正式员工”= 雇佣关系内部员工（含试用，不含实习生），与人事看板第 1 项同一口径。 */
export const BOARD_EMPLOY_TYPES = ['internal'];

/**
 * UUID 参数的单一入口（BE-13a 两个看板、明细与报表同用）：校验接受大小写，下游按小写比较（TS 内的相等 / 链查找、
 * SQL 里 uuid::text 的分组键都是小写），所以在入口统一转小写，下游不再各自处理大小写。
 */
const canonicalUuid = (raw: string) => (isUuid(raw) ? raw.toLowerCase() : raw);

export function uuidQuery(c: Context, name: string): string | undefined {
  const raw = c.req.query(name);
  if (raw !== undefined && !isUuid(raw)) throw new AppError('VALIDATION_FAILED', `${name} 必须是 UUID`);
  return raw === undefined ? undefined : canonicalUuid(raw);
}
/** 明细的分组键：机构 / 职级 / 序列 / 公司 / 合同类型是 UUID，同样转小写；分段键（regular、6mto1y、男…）原样。 */
export function groupQuery(c: Context): string | undefined {
  const raw = c.req.query('group');
  return raw === undefined ? undefined : canonicalUuid(raw);
}
const textQuery = (c: Context, name: string) => c.req.query(name) || undefined;
/** “包含下级”开关：只收 true / false（同 part-time 等列表的 includeChildren），缺省 = 勾选（规格 35 B49「F-437 补」）。 */
function includeChildrenQuery(c: Context, name: string): boolean {
  const raw = c.req.query(name);
  if (raw !== undefined && raw !== 'true' && raw !== 'false')
    throw new AppError('VALIDATION_FAILED', `${name} 只能是 true / false`);
  return raw !== 'false';
}
/** 任职部门筛选（看板与报表同一写法）。 */
export const departmentFilter = (c: Context) => ({
  departmentId: uuidQuery(c, 'departmentId'),
  departmentIncludeChildren: includeChildrenQuery(c, 'departmentIncludeChildren'),
});

function boardFilter(c: Context): StructureFilter {
  return {
    institutionId: uuidQuery(c, 'institutionId'),
    institutionIncludeChildren: includeChildrenQuery(c, 'institutionIncludeChildren'),
    ...departmentFilter(c),
    sequenceId: uuidQuery(c, 'sequenceId'),
    employmentForm: textQuery(c, 'employmentForm'),
    employmentType: textQuery(c, 'employmentType'),
  };
}

type Analytics = Awaited<ReturnType<typeof analyticsScope>>;

async function boardContext(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const base = await objectContext(c, deps, HR_STRUCTURE_OBJECT, 'view');
  return analyticsScope(c, deps, base, HR_STRUCTURE_OBJECT);
}
async function reportContext(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const base = await objectContext(c, deps, HR_STRUCTURE_REPORT_OBJECT, 'view');
  return analyticsScope(c, deps, base, HR_STRUCTURE_REPORT_OBJECT);
}

export async function lookupOf(tx: Tx, tenantId: string, asOf: string): Promise<StructureLookup> {
  return {
    asOf,
    tree: await orgTree(tx, tenantId, asOf),
    sequences: await jobDictionary(tx, tenantId, asOf, 'sequence'),
    levels: await jobDictionary(tx, tenantId, asOf, 'level'),
  };
}

/** 范围内、过了筛选的人员与时点资料；看板、明细、报表都从这里取。 */
function loadPeople(deps: TenantRouteDeps, ctx: Analytics, types: readonly string[], filter: StructureFilter) {
  const { base, scope, asOf } = ctx;
  return withTenant(deps.db, base.tenantId, async (tx) => {
    const lookup = await lookupOf(tx, base.tenantId, asOf);
    const people = await structurePeople(tx, { tenantId: base.tenantId, asOf, scope }, types);
    return { lookup, people: filterPeople(people, filter, lookup.tree) };
  });
}

export function registerHrStructureRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(HR_STRUCTURE_BASE, async (c) => {
    const ctx = await boardContext(c, deps);
    const { lookup, people } = await loadPeople(deps, ctx, BOARD_EMPLOY_TYPES, boardFilter(c));
    return c.json({
      asOf: ctx.asOf,
      hasDataPermission: ctx.scope.hasDataPermission,
      components: structureComponents(people, lookup),
    });
  });

  router.get(`${HR_STRUCTURE_BASE}/components/:code`, async (c) => {
    const ctx = await boardContext(c, deps);
    const component = HR_STRUCTURE_COMPONENTS.find((item) => item.code === c.req.param('code'));
    if (!component || component.kind === 'unavailable') throw new AppError('NOT_FOUND', '组件不存在或没有数据源');
    const group = groupQuery(c);
    if (group !== undefined && !isGrouped(component.code)) throw new AppError('VALIDATION_FAILED', '该组件没有分组');
    const filter = boardFilter(c);
    const page = pageQuery(c);
    const { lookup, people } = await loadPeople(deps, ctx, BOARD_EMPLOY_TYPES, filter);
    const members = componentMembers(component.code, people, lookup, group)!;
    return c.json({
      asOf: ctx.asOf,
      ...component,
      group: group ?? null,
      total: members.length,
      items: members
        .slice(page.offset, page.offset + page.limit)
        .map((p) => ({ id: p.id, employeeId: p.id, organizationId: p.departmentId })),
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope.hasDataPermission,
    });
  });

  router.get(`${HR_STRUCTURE_BASE}/reports/:report`, async (c) => {
    const ctx = await reportContext(c, deps);
    const report = reportOf(c);
    const employType = employTypeQuery(c);
    const { lookup, people } = await loadPeople(deps, ctx, employTypes(employType), departmentFilter(c));
    return c.json({
      asOf: ctx.asOf,
      report: report.code,
      name: report.name,
      employType,
      hasDataPermission: ctx.scope.hasDataPermission,
      ...structureReport(report.code, people, lookup),
    });
  });

  // 导出：只有「员工素质结构」；与页面报表接口同一份数据与裁剪，平均值不取整（F-482）
  router.get(`${HR_STRUCTURE_BASE}/reports/:report/export`, async (c) => {
    const ctx = await reportContext(c, deps);
    const report = reportOf(c);
    if (report.code !== 'quality') throw new AppError('NOT_FOUND', '该报表没有导出');
    const mode = exportMode(c);
    const employType = employTypeQuery(c);
    const filter = departmentFilter(c);
    const { lookup, people } = await loadPeople(deps, ctx, employTypes(employType), filter);
    const page = structureReport(report.code, people, lookup, { exact: true });
    return exportStatReport(c, deps, ctx.base, {
      object: HR_STRUCTURE_REPORT_OBJECT,
      reportCode: report.code,
      fileName: '员工素质结构.xlsx', // 原站文件名 = 报表名.xlsx（evidence §4），与页签名「员工素质结构统计」不同
      mode,
      // 审计摘要要能区分取数范围：“包含下级”的实际生效值（缺省 = 勾选）一并记（审查 P2-1，DEC-809④）
      filter: {
        asOf: ctx.asOf,
        employType,
        departmentId: filter.departmentId ?? null,
        departmentIncludeChildren: filter.departmentIncludeChildren,
      },
      layout: (stamp) => qualitySheet(page, stamp),
    });
  });
}

function reportOf(c: Context) {
  const report = HR_STRUCTURE_REPORTS.find((item) => item.code === c.req.param('report'));
  if (!report) throw new AppError('NOT_FOUND', '报表不存在');
  return report;
}
function employTypeQuery(c: Context): string {
  const employType = c.req.query('employType') ?? 'internal';
  if (!(HR_STRUCTURE_REPORT_EMPLOY_TYPES as readonly string[]).includes(employType))
    throw new AppError('VALIDATION_FAILED', `employType 只能是 ${HR_STRUCTURE_REPORT_EMPLOY_TYPES.join(' / ')}`);
  return employType;
}
const employTypes = (employType: string) => (employType === 'all' ? ['internal', 'intern'] : [employType]);
