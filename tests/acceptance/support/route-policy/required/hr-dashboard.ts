/**
 * 必需项表：人事看板（modules/analytics/hr-dashboard-routes.ts，R2-T10 BE-12b）。两个只读 GET 经 dashboardContext →
 * analyticsContext → objectContext 判对象 TenantBase.HrDashboard 的查看权（授权项“人事分析 - 人事看板 查看”）；
 * 数据范围在同一对象上解析（requestScope），由 hr-dashboard.ts 的 visible 在 SQL 内叠加，先于分页。无按钮、无写入。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/analytics/hr-dashboard';
const ROUTES = 'apps/api/src/modules/analytics/hr-dashboard-routes.ts';
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const OBJECT = 'TenantBase.HrDashboard';

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
      anchor: 'analyticsContext(c, deps, HR_DASHBOARD_OBJECT)',
    },
    {
      role: 'impl',
      unit: `${ROUTES}#analyticsContext`,
      anchor: "const base = await objectContext(c, deps, object, 'view')",
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
};
