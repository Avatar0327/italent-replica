/**
 * 必需项表：人员结构分析看板 / 员工结构报表（modules/analytics/hr-structure-routes.ts，R2-T10 BE-13a / F-547）。GET
 * 经 boardContext / reportContext → objectContext 判各自对象的查看权（看板 TenantBase.HrStructure、报表 TenantBase.HrStructureReport）；
 * 数据范围在同一对象上解析（requestScope），由 hr-structure.ts structurePeople 在 SQL 内叠加。无按钮、无业务写入。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/analytics/hr-structure';
const EXPORT = `${BASE}/components/:code/export`;
const ROUTES = 'apps/api/src/modules/analytics/hr-structure-routes.ts';
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const DOMAIN = 'packages/domain/src/analytics/hr-structure.ts';

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
const board = (path: string) => view(path, 'TenantBase.HrStructure', 'HR_STRUCTURE_OBJECT', 'boardContext');

export const HR_STRUCTURE: RequiredTable = {
  [`GET ${BASE}`]: [board(BASE)],
  [`GET ${BASE}/components/:code`]: [board(`${BASE}/components/:code`)],
  [`GET ${EXPORT}`]: [
    {
      ...board(EXPORT),
      need: { scope: 'list', predicate: 'hrStructure.visibility' },
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
          unit: 'apps/api/src/modules/analytics/hr-structure.ts#structurePeople',
          anchor: 'structurePeopleWhere(tx, a, employTypes, employmentVisible(a, sql`m`))',
        },
        {
          role: 'impl',
          unit: `${ROUTES}#projectMember`,
          anchor: 'return { id: p.id, employeeId: p.id, organizationId: p.departmentId }',
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
    view(`${BASE}/reports/:report`, 'TenantBase.HrStructureReport', 'HR_STRUCTURE_REPORT_OBJECT', 'reportContext'),
  ],
  [`GET ${BASE}/reports/:report/export`]: [
    view(
      `${BASE}/reports/:report/export`,
      'TenantBase.HrStructureReport',
      'HR_STRUCTURE_REPORT_OBJECT',
      'reportContext',
    ),
  ],
};
