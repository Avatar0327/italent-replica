/**
 * 人事看板路由（R2-T10 BE-12b，规格 35 §2.1）：
 * - GET /api/tenant/analytics/hr-dashboard?asOf=：23 项指标的数字（编码、名称、数值）；
 * - GET /api/tenant/analytics/hr-dashboard/indicators/:code?asOf=&page=&pageSize=：构成该数字的明细 ID 列表（分页）。
 * 权限链：对象 TenantBase.HrDashboard 的查看权（授权项“人事分析 - 人事看板 查看”）→ 同对象的数据范围（看全部默认给人事预置管理员，
 * 其余按管理单元，默认空即 0，不退回全部）。数字与明细共用 hr-dashboard.ts 的同一份候选行，所以范围、asOf 完全一致。
 * 明细下载沿用同一详情投影，文件完整生成后写一次操作日志（F-547 §5）；asOf 只定位业务有效日。
 */
import { withTenant, type Tx } from '@italent/db';
import { HR_DASHBOARD_INDICATORS, HR_DASHBOARD_OBJECT, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery } from '../job/context.js';
import { validIsoDate } from '../org/read-model.js';
import { objectContext, requestScope } from '../permission/module-route-access.js';
import { registerPersonScopedObject } from '../permission/scope-resolver.js';
import { COMPONENT_EXPORT_PAGE, exportComponent, validateComponentExportQuery } from './component-export.js';
import { dashboardRenewalTypes, hrDashboardCounts, hrDashboardPage, type DashboardAsOf } from './hr-dashboard.js';

export const HR_DASHBOARD_BASE = '/api/tenant/analytics/hr-dashboard';

// 人员类指标按员工归属裁剪：组织类范围规则对本对象同样带出“按人员”的关联谓词（与员工信息类对象同口径）
registerPersonScopedObject(HR_DASHBOARD_OBJECT);

/**
 * asOf 的可计算范围：窗口要算 asOf − 1 天与 asOf + 30 天，两端都必须还是合法日期（0001-01-01 之前、9999-12-31 之后没有日期），
 * 所以取 [0001-01-02, 9999-12-01]；格式与历法合法性复用组织模块的 validIsoDate（0000 年不合法）。
 */
const AS_OF_MIN = '0001-01-02';
const AS_OF_MAX = '9999-12-01';
export const validBoardDate = (value: string) => validIsoDate(value) && value >= AS_OF_MIN && value <= AS_OF_MAX;
/** 可选日期参数：缺省返回 undefined，不合法 400（BE-13a 合同变动日期区间同用）。 */
export function dateQuery(c: Context, name: string): string | undefined {
  const raw = c.req.query(name);
  if (raw !== undefined && !validBoardDate(raw))
    throw new AppError('VALIDATION_FAILED', `${name} 必须是 ${AS_OF_MIN} 至 ${AS_OF_MAX} 之间的 YYYY-MM-DD 日期`);
  return raw;
}

/**
 * 人事分析看板 / 报表的公共上下文（BE-13a 三个对象同用）：已过对象查看权的 base → 同对象的数据范围 → asOf（缺省租户当地今天）。
 * 查看权由各入口以对象常量调用 objectContext，F-039 探测按常量识别对象，所以不收进这里。
 */
export async function analyticsScope(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  base: Awaited<ReturnType<typeof objectContext>>,
  object: string,
) {
  const scope = await requestScope(c, deps, base, object);
  const asOf = dateQuery(c, 'asOf') ?? tenantLocalDate(base.now, base.timezone);
  return { base, scope, asOf };
}
async function dashboardContext(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const base = await objectContext(c, deps, HR_DASHBOARD_OBJECT, 'view');
  return analyticsScope(c, deps, base, HR_DASHBOARD_OBJECT);
}

const INDICATOR_ID_LABELS = {
  employee: '明细行 ID',
  business: '业务单 ID',
  contract: '合同记录 ID',
  offer: 'Offer ID',
  org: '部门 ID',
} as const;

function indicatorQuery(c: Context) {
  const indicator = HR_DASHBOARD_INDICATORS.find((item) => item.code === c.req.param('code'));
  if (!indicator) throw new AppError('NOT_FOUND', '指标不存在');
  return indicator;
}

async function dashboardAt(
  tx: Tx,
  { base, scope, asOf }: Awaited<ReturnType<typeof dashboardContext>>,
): Promise<DashboardAsOf> {
  return {
    tenantId: base.tenantId,
    asOf,
    timezone: base.timezone,
    scope,
    renewalTypeIds: await dashboardRenewalTypes(tx, base.tenantId),
  };
}

export function registerHrDashboardRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(HR_DASHBOARD_BASE, async (c) => {
    const { base, scope, asOf } = await dashboardContext(c, deps);
    const counts = await withTenant(deps.db, base.tenantId, async (tx) =>
      hrDashboardCounts(tx, {
        tenantId: base.tenantId,
        asOf,
        timezone: base.timezone,
        scope,
        renewalTypeIds: await dashboardRenewalTypes(tx, base.tenantId),
      }),
    );
    return c.json({
      asOf,
      hasDataPermission: scope.hasDataPermission,
      indicators: HR_DASHBOARD_INDICATORS.map((indicator) => ({
        ...indicator,
        value: counts.get(indicator.code) ?? 0,
      })),
    });
  });

  router.get(`${HR_DASHBOARD_BASE}/indicators/:code`, async (c) => {
    const { base, scope, asOf } = await dashboardContext(c, deps);
    const indicator = indicatorQuery(c);
    const page = pageQuery(c);
    const result = await withTenant(deps.db, base.tenantId, async (tx) =>
      hrDashboardPage(tx, indicator.code, await dashboardAt(tx, { base, scope, asOf }), page),
    );
    return c.json({
      asOf,
      ...indicator,
      ...result,
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: scope.hasDataPermission,
    });
  });

  router.get(`${HR_DASHBOARD_BASE}/indicators/:code/export`, async (c) => {
    const { base, scope, asOf } = await dashboardContext(c, deps);
    validateComponentExportQuery(c, ['asOf']);
    const indicator = indicatorQuery(c);
    const result = await withTenant(deps.db, base.tenantId, async (tx) =>
      hrDashboardPage(tx, indicator.code, await dashboardAt(tx, { base, scope, asOf }), COMPONENT_EXPORT_PAGE),
    );
    const idLabel = indicator.code === 'contractApproving' ? '申请单 ID' : INDICATOR_ID_LABELS[indicator.subject];
    return exportComponent(
      c,
      deps,
      base,
      {
        board: 'hr-dashboard',
        object: HR_DASHBOARD_OBJECT,
        component: indicator,
        asOf,
        columns: [
          { key: 'id', label: idLabel },
          { key: 'employeeId', label: '员工 ID' },
        ],
      },
      result,
    );
  });
}
