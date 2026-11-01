/**
 * 必需项表：人员结构分析看板 / 员工结构报表（modules/analytics/hr-structure-routes.ts，R2-T10 BE-13a）。三个只读 GET
 * 经 boardContext / reportContext → objectContext 判各自对象的查看权（看板 TenantBase.HrStructure、报表 TenantBase.HrStructureReport）；
 * 数据范围在同一对象上解析（requestScope），由 hr-structure.ts structurePeople 在 SQL 内叠加。无按钮、无写入。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/analytics/hr-structure';
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
  [`GET ${BASE}/reports/:report`]: [
    view(`${BASE}/reports/:report`, 'TenantBase.HrStructureReport', 'HR_STRUCTURE_REPORT_OBJECT', 'reportContext'),
  ],
};
