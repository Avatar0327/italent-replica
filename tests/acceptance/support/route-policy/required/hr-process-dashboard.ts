/**
 * 必需项表：人事流程看板（modules/analytics/hr-process-dashboard-routes.ts，R2 BE-13c）。两个只读 GET 经 processContext →
 * objectContext 判对象 TenantBase.HrProcessDashboard 的查看权（授权项“人事分析 - 人事流程看板 查看”）；数据范围在同一对象上
 * 解析（requestScope），与审批披露（参与人 / adminScope）一起在 hr-process-dashboard.ts 的 SQL 内叠加，先于分页。无按钮、无写入。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/analytics/hr-process-dashboard';
const ROUTES = 'apps/api/src/modules/analytics/hr-process-dashboard-routes.ts';
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const OBJECT = 'TenantBase.HrProcessDashboard';

const view = (path: string): Obligation => ({
  perm: `obj:${OBJECT}:view`,
  facts: ['object:objectContext', `objectOp:${OBJECT}:view`],
  at: [
    { role: 'call', unit: `${ROUTES}#route:GET ${path}`, anchor: 'const p = await processContext(c, deps)' },
    {
      role: 'impl',
      unit: `${ROUTES}#processContext`,
      anchor: "const base = await objectContext(c, deps, HR_PROCESS_DASHBOARD_OBJECT, 'view')",
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
      unit: 'packages/domain/src/analytics/hr-process-dashboard.ts#HR_PROCESS_DASHBOARD_OBJECT',
      anchor: "'TenantBase.HrProcessDashboard'",
    },
  ] satisfies Evidence[],
});

export const HR_PROCESS_DASHBOARD: RequiredTable = {
  [`GET ${BASE}`]: [view(BASE)],
  [`GET ${BASE}/components/:code`]: [view(`${BASE}/components/:code`)],
};
