/**
 * 必需项表：合同情况看板（modules/analytics/contract-board-routes.ts，R2-T10 BE-13a）。两个只读 GET 经 boardContext →
 * analyticsContext → objectContext 判对象 TenantBase.ContractBoard 的查看权；数据范围在同一对象上解析（requestScope），
 * 由 contract-board.ts boardRows 在 SQL 内叠加，先于分组与分页。无按钮、无写入。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/analytics/contract-board';
const ROUTES = 'apps/api/src/modules/analytics/contract-board-routes.ts';
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const OBJECT = 'TenantBase.ContractBoard';

const view = (path: string): Obligation => ({
  perm: `obj:${OBJECT}:view`,
  facts: ['object:objectContext', `objectOp:${OBJECT}:view`],
  at: [
    { role: 'call', unit: `${ROUTES}#route:GET ${path}`, anchor: 'const ctx = await boardContext(c, deps)' },
    {
      role: 'impl',
      unit: `${ROUTES}#boardContext`,
      anchor: 'const ctx = await analyticsContext(c, deps, CONTRACT_BOARD_OBJECT)',
    },
    {
      role: 'impl',
      unit: 'apps/api/src/modules/analytics/hr-dashboard-routes.ts#analyticsContext',
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
      unit: 'packages/domain/src/analytics/hr-structure.ts#CONTRACT_BOARD_OBJECT',
      anchor: `'${OBJECT}'`,
    },
  ] satisfies Evidence[],
});

export const CONTRACT_BOARD: RequiredTable = {
  [`GET ${BASE}`]: [view(BASE)],
  [`GET ${BASE}/components/:code`]: [view(`${BASE}/components/:code`)],
};
