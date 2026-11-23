/**
 * 必需项表：人事看板（modules/analytics/hr-dashboard-routes.ts，R2-T10 BE-12b / F-547）。三个 GET 经 dashboardContext →
 * objectContext 判对象 TenantBase.HrDashboard 的查看权（授权项“人事分析 - 人事看板 查看”）；数据范围在同一对象上解析
 * （requestScope），由 hr-dashboard.ts 的 visible 在 SQL 内叠加，先于分页。无按钮、无业务写入。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/analytics/hr-dashboard';
const ROUTES = 'apps/api/src/modules/analytics/hr-dashboard-routes.ts';
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const OBJECT = 'TenantBase.HrDashboard';
const EXPORT = `${BASE}/indicators/:code/export`;

const view = (path: string): Obligation => ({
  perm: `obj:${OBJECT}:view`,
  facts: ['object:objectContext', `objectOp:${OBJECT}:view`],
  at: [
    {
      role: 'call',
      unit: `${ROUTES}#route:GET ${path}`,
      anchor: 'const { base, scope, asOf } = await dashboardContext(c, deps)',
    },
    {
      role: 'impl',
      unit: `${ROUTES}#dashboardContext`,
      anchor: "const base = await objectContext(c, deps, HR_DASHBOARD_OBJECT, 'view')",
    },
    {
      role: 'impl',
      unit: `${MRA}#objectContext`,
      anchor:
        'await requirePermission(deps.authorize, { ...ctx, action: `object.${operation}`, ' +
        'resource: objectCode, fields: [] })',
    },
    {
      role: 'const',
      unit: 'packages/domain/src/analytics/hr-dashboard.ts#HR_DASHBOARD_OBJECT',
      anchor: "'TenantBase.HrDashboard'",
    },
  ] satisfies Evidence[],
});

export const HR_DASHBOARD: RequiredTable = {
  [`GET ${BASE}`]: [view(BASE)],
  [`GET ${BASE}/indicators/:code`]: [view(`${BASE}/indicators/:code`)],
  [`GET ${EXPORT}`]: [
    {
      ...view(EXPORT),
      need: { scope: 'list', predicate: 'hrDashboard.visibility' },
      note: 'CSV 固定文件，范围内明细的 id、employeeId，与分页明细同投影',
      at: [
        ...view(EXPORT).at,
        {
          role: 'scope',
          unit: `${ROUTES}#analyticsScope`,
          anchor: 'const scope = await requestScope(c, deps, base, object)',
        },
        {
          role: 'scope',
          unit: 'apps/api/src/modules/analytics/hr-dashboard.ts#indicatorRows',
          anchor: 'visible(a, metric.visibility)',
        },
        {
          role: 'impl',
          unit: 'apps/api/src/modules/analytics/hr-dashboard.ts#hrDashboardPage',
          anchor: 'items: result.items.map(({ id, employeeId }) => ({ id, employeeId }))',
        },
        {
          role: 'call',
          unit: `${ROUTES}#route:GET ${EXPORT}`,
          anchor: "{ key: 'employeeId', label: '员工 ID' }",
        },
      ],
    },
  ],
};
