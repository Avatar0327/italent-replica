/**
 * 合同情况看板（B55）的只读路由（R2 BE-13a，规格 35“补充：BE-13…”）：
 * - GET /api/tenant/analytics/contract-board?asOf=&changeFrom=&changeTo=&companyId=&typeId=&termType=：8 个组件；
 * - GET …/contract-board/components/:code?group=&page=&pageSize=：构成数字（或某个分组）的申请单 / 合同明细，分页。
 * 对象 TenantBase.ContractBoard 的查看权与数据范围；只读，不写台账 / 审计；下载归前端（DEC-708）。
 */
import { withTenant } from '@italent/db';
import { CONTRACT_BOARD_COMPONENTS, CONTRACT_BOARD_OBJECT } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery } from '../job/context.js';
import { objectContext } from '../permission/module-route-access.js';
import { registerPersonScopedObject } from '../permission/scope-resolver.js';
import {
  contractBoardComponents,
  contractBoardPage,
  CONTRACT_TERM_TYPES,
  isGroupedContractComponent,
  type ContractBoardContext,
} from './contract-board.js';
import { dashboardRenewalTypes } from './hr-dashboard.js';
import { analyticsScope, dateQuery } from './hr-dashboard-routes.js';
import { uuidQuery } from './hr-structure-routes.js';

export const CONTRACT_BOARD_BASE = '/api/tenant/analytics/contract-board';

registerPersonScopedObject(CONTRACT_BOARD_OBJECT);

/** 看板筛选；变动日期缺省为 asOf 所在年的全年。参数先校验完再进事务。 */
function boardFilter(c: Context, asOf: string): ContractBoardContext['filter'] {
  const year = asOf.slice(0, 4);
  const changeFrom = dateQuery(c, 'changeFrom') ?? `${year}-01-01`;
  const changeTo = dateQuery(c, 'changeTo') ?? `${year}-12-31`;
  if (changeFrom > changeTo) throw new AppError('VALIDATION_FAILED', 'changeFrom 不能晚于 changeTo');
  const termType = c.req.query('termType') || undefined;
  if (termType !== undefined && !(CONTRACT_TERM_TYPES as readonly string[]).includes(termType))
    throw new AppError('VALIDATION_FAILED', `termType 只能是 ${CONTRACT_TERM_TYPES.join(' / ')}`);
  return { changeFrom, changeTo, companyId: uuidQuery(c, 'companyId'), typeId: uuidQuery(c, 'typeId'), termType };
}

async function boardContext(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const base = await objectContext(c, deps, CONTRACT_BOARD_OBJECT, 'view');
  const ctx = await analyticsScope(c, deps, base, CONTRACT_BOARD_OBJECT);
  const filter = boardFilter(c, ctx.asOf);
  const at = (renewalTypeIds: readonly string[]): ContractBoardContext => ({
    a: { tenantId: ctx.base.tenantId, asOf: ctx.asOf, timezone: ctx.base.timezone, scope: ctx.scope, renewalTypeIds },
    filter,
  });
  return { ...ctx, at };
}

export function registerContractBoardRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(CONTRACT_BOARD_BASE, async (c) => {
    const ctx = await boardContext(c, deps);
    const components = await withTenant(deps.db, ctx.base.tenantId, async (tx) =>
      contractBoardComponents(tx, ctx.at(await dashboardRenewalTypes(tx, ctx.base.tenantId))),
    );
    return c.json({ asOf: ctx.asOf, hasDataPermission: ctx.scope.hasDataPermission, components });
  });

  router.get(`${CONTRACT_BOARD_BASE}/components/:code`, async (c) => {
    const ctx = await boardContext(c, deps);
    const component = CONTRACT_BOARD_COMPONENTS.find((item) => item.code === c.req.param('code'));
    if (!component) throw new AppError('NOT_FOUND', '组件不存在');
    const group = c.req.query('group');
    if (group !== undefined && !isGroupedContractComponent(component.code))
      throw new AppError('VALIDATION_FAILED', '该组件没有分组');
    const page = pageQuery(c);
    const result = await withTenant(deps.db, ctx.base.tenantId, async (tx) =>
      contractBoardPage(tx, component.code, ctx.at(await dashboardRenewalTypes(tx, ctx.base.tenantId)), group, page),
    );
    return c.json({
      asOf: ctx.asOf,
      ...component,
      group: group ?? null,
      total: result.total,
      items: result.items,
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope.hasDataPermission,
    });
  });
}
