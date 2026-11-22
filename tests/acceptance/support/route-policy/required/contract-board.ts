/**
 * 必需项表：合同情况看板（modules/analytics/contract-board-routes.ts，R2-T10 BE-13a / F-547）。三个 GET 经 boardContext →
 * objectContext 判对象 TenantBase.ContractBoard 的查看权；数据范围在同一对象上解析（requestScope），
 * 由 contract-board.ts boardRows 在 SQL 内叠加，先于分组与分页。无按钮、无业务写入。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/analytics/contract-board';
const ROUTES = 'apps/api/src/modules/analytics/contract-board-routes.ts';
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const OBJECT = 'TenantBase.ContractBoard';
const EXPORT = `${BASE}/components/:code/export`;

const view = (path: string): Obligation => ({
  perm: `obj:${OBJECT}:view`,
  facts: ['object:objectContext', `objectOp:${OBJECT}:view`],
  at: [
    { role: 'call', unit: `${ROUTES}#route:GET ${path}`, anchor: 'const ctx = await boardContext(c, deps)' },
    {
      role: 'impl',
      unit: `${ROUTES}#boardContext`,
      anchor: "const base = await objectContext(c, deps, CONTRACT_BOARD_OBJECT, 'view')",
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
      unit: 'packages/domain/src/analytics/hr-structure.ts#CONTRACT_BOARD_OBJECT',
      anchor: `'${OBJECT}'`,
    },
  ] satisfies Evidence[],
});

export const CONTRACT_BOARD: RequiredTable = {
  [`GET ${BASE}`]: [view(BASE)],
  [`GET ${BASE}/components/:code`]: [view(`${BASE}/components/:code`)],
  [`GET ${EXPORT}`]: [
    {
      ...view(EXPORT),
      need: { scope: 'list', predicate: 'contractBoard.visibility' },
      note: 'CSV 固定文件，范围内明细的 id、employeeId、organizationId，与分页明细同投影',
      at: [
        ...view(EXPORT).at,
        {
          role: 'scope',
          unit: 'apps/api/src/modules/analytics/hr-dashboard-routes.ts#analyticsScope',
          anchor: 'const scope = await requestScope(c, deps, base, object)',
        },
        {
          role: 'scope',
          unit: 'apps/api/src/modules/analytics/contract-board.ts#boardRows',
          anchor: 'employmentVisible(x.a, sql`m`)',
        },
        {
          role: 'impl',
          unit: 'apps/api/src/modules/analytics/hr-dashboard.ts#pageRows',
          anchor: '({ id: row.id!, employeeId: row.employeeId, organizationId: row.organizationId })',
        },
        {
          role: 'call',
          unit: `${ROUTES}#route:GET ${EXPORT}`,
          anchor: "{ key: 'organizationId', label: '组织 ID' }",
        },
      ],
    },
  ],
};
