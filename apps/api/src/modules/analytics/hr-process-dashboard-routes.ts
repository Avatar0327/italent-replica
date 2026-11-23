/**
 * 人事流程看板路由（R2 BE-13c，规格 35 B51）：
 * - GET /api/tenant/analytics/hr-process-dashboard?asOf=&from=&to=&category=&departmentId=：24 个组件的主数、副值、平均值与分组；
 * - GET .../components/:code?（同上筛选）&group=&series=&hit=&page=&pageSize=：构成该数字（或该组）的明细（分页）。
 * - GET .../components/:code/export：同一详情行集的全量 CSV，交付前写操作日志（F-547）。
 * 权限链：对象 TenantBase.HrProcessDashboard 的查看权（授权项“人事分析 - 人事流程看板 查看”）→ 同对象的数据范围；
 * 审批实例另须调用者本来就能看到（发起人 / 处理人 / 抄送人，或审批管理员按钮 + 业务对象范围，access.ts adminScope），
 * 看板不扩大审批的可见面。三个入口均不写业务数据或命令台账。
 */
import { withTenant } from '@italent/db';
import {
  addDays,
  APPROVAL_CATEGORIES,
  HR_PROCESS_COMPONENTS,
  HR_PROCESS_DASHBOARD_OBJECT,
  HR_PROCESS_DEFAULT_DAYS,
  tenantLocalDate,
  type ApprovalCategory,
  type HrProcessComponent,
} from '@italent/domain';
import { sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { adminScope } from '../approval/access.js';
import { pageQuery } from '../job/context.js';
import { validIsoDate } from '../org/read-model.js';
import { objectContext, requestScope } from '../permission/module-route-access.js';
import { registerPersonScopedObject } from '../permission/scope-resolver.js';
import { COMPONENT_EXPORT_PAGE, exportComponent, validateComponentExportQuery } from './component-export.js';
import { hrProcessOverview, hrProcessPage, type DetailFilter, type ProcessContext } from './hr-process-dashboard.js';

export const HR_PROCESS_DASHBOARD_BASE = '/api/tenant/analytics/hr-process-dashboard';

registerPersonScopedObject(HR_PROCESS_DASHBOARD_OBJECT);

/** 日期参数范围同人事看板（窗口起点要算 asOf − 29 天）。 */
const DATE_MIN = '0001-01-02';
const DATE_MAX = '9999-12-01';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dateParam(c: Context<TenantEnv>, name: string): string | undefined {
  const raw = c.req.query(name);
  if (raw !== undefined && !(validIsoDate(raw) && raw >= DATE_MIN && raw <= DATE_MAX))
    throw new AppError('VALIDATION_FAILED', `${name} 必须是 ${DATE_MIN} 至 ${DATE_MAX} 之间的 YYYY-MM-DD 日期`);
  return raw;
}

function filters(c: Context<TenantEnv>) {
  const category = c.req.query('category');
  if (category !== undefined && !(APPROVAL_CATEGORIES as readonly string[]).includes(category))
    throw new AppError('VALIDATION_FAILED', 'category 不是有效的审批类别');
  const departmentId = c.req.query('departmentId');
  if (departmentId !== undefined && !UUID.test(departmentId))
    throw new AppError('VALIDATION_FAILED', 'departmentId 必须是组织 ID');
  return {
    ...(category ? { category: category as ApprovalCategory } : {}),
    ...(departmentId ? { departmentId: departmentId.toLowerCase() } : {}),
  };
}

/** 审批披露：参与人（发起 / 处理 / 抄送，同我的审批列表）或审批管理员按钮下的业务对象范围。 */
async function approvalVisible(deps: TenantRouteDeps, base: Awaited<ReturnType<typeof objectContext>>) {
  const admin = await adminScope(deps, base, ['adminTransfer', 'adminIntervene']);
  const user = sql`${base.userId}::uuid`;
  return sql`(i.initiator_user_id=${user}
    OR EXISTS (SELECT 1 FROM approval_tasks t WHERE t.tenant_id=i.tenant_id AND t.instance_id=i.id
      AND t.assignee_user_id=${user} AND t.origin NOT IN ('self_skip','subject_skip'))
    OR EXISTS (SELECT 1 FROM approval_instance_ccs cc WHERE cc.tenant_id=i.tenant_id AND cc.instance_id=i.id
      AND cc.user_id=${user})
    OR ${admin ?? sql`false`})`;
}

async function processContext(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const base = await objectContext(c, deps, HR_PROCESS_DASHBOARD_OBJECT, 'view');
  const scope = await requestScope(c, deps, base, HR_PROCESS_DASHBOARD_OBJECT);
  const asOf = dateParam(c, 'asOf') ?? tenantLocalDate(base.now, base.timezone);
  const to = dateParam(c, 'to') ?? asOf;
  const from = dateParam(c, 'from') ?? addDays(asOf, 1 - HR_PROCESS_DEFAULT_DAYS);
  if (from > to) throw new AppError('VALIDATION_FAILED', 'from 不能晚于 to');
  return {
    base,
    tenantId: base.tenantId,
    asOf,
    from,
    to,
    timezone: base.timezone,
    scope,
    approval: await approvalVisible(deps, base),
    ...filters(c),
  };
}

function detailFilter(c: Context<TenantEnv>): DetailFilter {
  const hit = c.req.query('hit');
  if (hit !== undefined && hit !== 'true' && hit !== 'false')
    throw new AppError('VALIDATION_FAILED', 'hit 只能是 true 或 false');
  const group = c.req.query('group');
  const series = c.req.query('series');
  return {
    ...(group === undefined ? {} : { group }),
    ...(series === undefined ? {} : { series }),
    ...(hit === undefined ? {} : { hit: hit === 'true' }),
  };
}

function componentOf(c: Context) {
  const component = HR_PROCESS_COMPONENTS.find((item) => item.code === c.req.param('code'));
  if (!component) throw new AppError('NOT_FOUND', '组件不存在');
  return component;
}

const window = (p: ProcessContext) => ({
  asOf: p.asOf,
  from: p.from,
  to: p.to,
  hasDataPermission: p.scope.hasDataPermission,
});

const INSTANCE_COLUMN = { key: 'instanceId', label: '审批实例 ID' };
const DETAIL_ROW_COLUMN = { key: 'id', label: '明细行 ID' };
const DETAIL_COLUMNS = [
  { key: 'group', label: '分组' },
  { key: 'series', label: '系列' },
  { key: 'value', label: '值' },
  { key: 'hit', label: '是否命中' },
];

// 契约 §3：首列是审批实例 ID，末尾追加通用键，实例 ID 只写一次。
const IN_FLIGHT_EXPORT_COLUMNS = [
  INSTANCE_COLUMN,
  { key: 'title', label: '流程实例名称' },
  { key: 'category', label: '审批类别' },
  { key: 'currentNode', label: '当前节点' },
  { key: 'currentApproverUserId', label: '当前审批人 ID' },
  { key: 'approverStatus', label: '审批人状态' },
  { key: 'departmentId', label: '部门 ID' },
  { key: 'directManagerId', label: '直线经理 ID' },
  { key: 'initiatorUserId', label: '发起人 ID' },
  { key: 'startedAt', label: '发起时间' },
  { key: 'arrivedAt', label: '任务到达时间' },
  { key: 'businessDate', label: '业务日期' },
  { key: 'abnormalTypes', label: '在途异常类型' },
  { key: 'waitBucket', label: '等待时间段' },
  { key: 'approvedCount', label: '审批计数' },
  DETAIL_ROW_COLUMN,
  ...DETAIL_COLUMNS,
];

function processExportColumns(component: HrProcessComponent) {
  if (component.code === 'inFlightList') return IN_FLIGHT_EXPORT_COLUMNS;
  const labels = { instance: DETAIL_ROW_COLUMN.label, task: '任务 ID', business: '业务单 ID' };
  return [{ key: 'id', label: labels[component.subject] }, INSTANCE_COLUMN, ...DETAIL_COLUMNS];
}

function registerComponentExportRoute(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${HR_PROCESS_DASHBOARD_BASE}/components/:code/export`, async (c) => {
    const p = await processContext(c, deps);
    validateComponentExportQuery(c, ['asOf', 'from', 'to', 'category', 'departmentId', 'group', 'series', 'hit']);
    const component = componentOf(c);
    // DEC-970：F-543 修正 7.2.15 后，由后合入片开放下载并补与 D 的正向对照。
    if (component.code === 'lateApprovalByApprover') throw new AppError('NOT_FOUND', '组件不存在');
    const filter = detailFilter(c);
    const result = await withTenant(deps.db, p.tenantId, (tx) =>
      hrProcessPage(tx, component.code, p, filter, COMPONENT_EXPORT_PAGE),
    );
    return exportComponent(
      c,
      deps,
      p.base,
      {
        board: 'hr-process-dashboard',
        object: HR_PROCESS_DASHBOARD_OBJECT,
        component,
        asOf: p.asOf,
        columns: processExportColumns(component),
      },
      result,
    );
  });
}

export function registerHrProcessDashboardRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(HR_PROCESS_DASHBOARD_BASE, async (c) => {
    const p = await processContext(c, deps);
    const components = await withTenant(deps.db, p.tenantId, (tx) => hrProcessOverview(tx, p));
    return c.json({ ...window(p), components });
  });

  router.get(`${HR_PROCESS_DASHBOARD_BASE}/components/:code`, async (c) => {
    const p = await processContext(c, deps);
    const component = componentOf(c);
    const filter = detailFilter(c);
    const page = pageQuery(c);
    const result = await withTenant(deps.db, p.tenantId, (tx) => hrProcessPage(tx, component.code, p, filter, page));
    return c.json({ ...window(p), ...component, ...result, page: page.page, pageSize: page.pageSize });
  });
  registerComponentExportRoute(router, deps);
}
