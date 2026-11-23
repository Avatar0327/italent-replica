/**
 * 必需项表：人员流动分析看板 / 流动情况报表（modules/analytics/hr-movement-routes.ts，R2-T10 BE-13b / F-547）。GET
 * 经 boardContext / reportContext → objectContext 判各自对象的查看权（看板 TenantBase.HrMovement、报表 TenantBase.HrMovementReport）；
 * 数据范围在同一对象上解析（requestScope），由 hr-movement.ts loadMovement 在 SQL 内叠加。无按钮、无业务写入。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/analytics/hr-movement';
const EXPORT = `${BASE}/components/:code/export`;
const ROUTES = 'apps/api/src/modules/analytics/hr-movement-routes.ts';
const DATA = 'apps/api/src/modules/analytics/hr-movement.ts';
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const DOMAIN = 'packages/domain/src/analytics/hr-movement.ts';

const view = (path: string, object: string, constant: string, context: string): Obligation => ({
  perm: `obj:${object}:view`,
  facts: ['object:objectContext', `objectOp:${object}:view`],
  at: [
    { role: 'call', unit: `${ROUTES}#route:GET ${path}`, anchor: `const ctx = await ${context}(c, deps)` },
    {
      role: 'impl',
      unit: `${ROUTES}#${context}`,
      anchor: `const base = await objectContext(c, deps, ${constant}, 'view')`,
    },
    {
      role: 'impl',
      unit: `${MRA}#objectContext`,
      anchor:
        'await requirePermission(deps.authorize, { ...ctx, action: `object.${operation}`, ' +
        'resource: objectCode, fields: [] })',
    },
    { role: 'const', unit: `${DOMAIN}#${constant}`, anchor: `'${object}'` },
  ] satisfies Evidence[],
});
const board = (path: string) => view(path, 'TenantBase.HrMovement', 'HR_MOVEMENT_OBJECT', 'boardContext');

export const HR_MOVEMENT: RequiredTable = {
  [`GET ${BASE}`]: [board(BASE)],
  [`GET ${BASE}/components/:code`]: [board(`${BASE}/components/:code`)],
  [`GET ${EXPORT}`]: [
    {
      ...board(EXPORT),
      need: { scope: 'list', predicate: 'hrMovement.visibility' },
      note: 'CSV 固定文件，只含范围内明细的 id、employeeId、organizationId，与分页明细同投影',
      at: [
        ...board(EXPORT).at,
        {
          role: 'scope',
          unit: 'apps/api/src/modules/analytics/hr-dashboard-routes.ts#analyticsScope',
          anchor: 'const scope = await requestScope(c, deps, base, object)',
        },
        {
          role: 'scope',
          unit: `${ROUTES}#loadBoard`,
          anchor: 'loadMovement(tx, { tenantId: base.tenantId, asOf, scope }, window)',
        },
        {
          role: 'scope',
          unit: `${DATA}#loadMovement`,
          anchor:
            'exits: await exits(tx, a, { from, to, dating: window.exitDating }), ' +
            'hires: await hires(tx, a, from, to), transfers: await transfers(tx, a, from, to)',
        },
        {
          role: 'scope',
          unit: `${DATA}#loadMovement`,
          anchor: 'snapshots: await snapshots(tx, a, [...new Set(window.days)])',
        },
        {
          role: 'scope',
          unit: 'apps/api/src/modules/analytics/hr-dashboard.ts#employmentVisible',
          anchor: 'return employmentVisibilitySql(a.scope,',
        },
        {
          role: 'scope',
          unit: `${DATA}#loadEstablishment`,
          anchor: 'listCapacities(tx, a.tenantId, day, { scope: a.scope, covering: day }, { limit, offset })',
        },
        {
          role: 'impl',
          unit: `${ROUTES}#projectMember`,
          anchor: 'return { id: m.employeeId, employeeId: m.employeeId, organizationId: m.departmentId }',
        },
        {
          role: 'call',
          unit: `${ROUTES}#route:GET ${EXPORT}`,
          anchor: "{ key: 'organizationId', label: '组织 ID' }",
        },
      ],
    },
  ],
  [`GET ${BASE}/reports/:report`]: [
    view(`${BASE}/reports/:report`, 'TenantBase.HrMovementReport', 'HR_MOVEMENT_REPORT_OBJECT', 'reportContext'),
  ],
  [`GET ${BASE}/reports/:report/export`]: [
    view(`${BASE}/reports/:report/export`, 'TenantBase.HrMovementReport', 'HR_MOVEMENT_REPORT_OBJECT', 'reportContext'),
  ],
};
