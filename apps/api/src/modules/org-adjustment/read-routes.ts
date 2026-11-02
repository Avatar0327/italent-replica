/**
 * 组织调整读路由（R2-T08 §9.3 路由 12～15、§10、§4.5；BE-10d）。没有导出入口（10e）。
 * - 12 列表：对象查看权（无权 403）→ 主体组织按 OrganizationApproval 范围在 SQL 里先过滤再分页；列按字段查看权裁剪。
 * - 13 详情 / 14 明细 / 15 预览：同一事务内经 `orgAdjustmentDisclosure` 判一次（HR 读权 + 范围，或可打开最新审批实例），
 *   不通过与不存在同一 404 文案。只读，不进命令台账。
 */
import { withTenant } from '@italent/db';
import { ORG_ADJUSTMENT_OBJECT_CODE } from '@italent/domain';
import type { Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { pageQuery, uuidParam } from '../job/context.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { objectContext } from '../permission/module-route-access.js';
import { readDetail, readItems } from './detail.js';
import { orgAdjustmentDisclosure } from './disclosure.js';
import { readPreview } from './preview.js';
import { listAdjustments, listColumns, parseListFilter, projectHeads } from './queries.js';

const BASE = '/api/tenant/org-adjustment/adjustments';
const OBJECT = ORG_ADJUSTMENT_OBJECT_CODE;

export function registerReadRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(BASE, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'view');
    const filter = parseListFilter((name) => c.req.query(name));
    const page = pageQuery(c);
    const body = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
      const scope = await resolveModuleScopeInTransaction(bound, ctx, tx, OBJECT);
      const fields = await getModuleViewableFieldsInTransaction(bound, ctx, OBJECT, tx);
      const { rows, total } = await listAdjustments(tx, ctx.tenantId, scope, filter, page);
      const items = (await projectHeads(tx, ctx.tenantId, rows, fields)).map(listColumns);
      return { items, total, page: page.page, pageSize: page.pageSize };
    });
    return c.json(body, 200);
  });

  router.get(`${BASE}/:id`, async (c) => {
    const ctx = tenantOf(c);
    const id = uuidParam(c);
    const body = await withTenant(deps.db, ctx.tenantId, async (tx) =>
      readDetail(tx, ctx.tenantId, await orgAdjustmentDisclosure(tx, deps, ctx, id)),
    );
    return c.json(body, 200);
  });

  router.get(`${BASE}/:id/items/:section`, async (c) => {
    const ctx = tenantOf(c);
    const id = uuidParam(c);
    const section = c.req.param('section');
    const body = await withTenant(deps.db, ctx.tenantId, async (tx) =>
      readItems(tx, ctx.tenantId, await orgAdjustmentDisclosure(tx, deps, ctx, id), section),
    );
    return c.json(body, 200);
  });

  router.get(`${BASE}/:id/preview`, async (c) => {
    const ctx = tenantOf(c);
    const id = uuidParam(c);
    const body = await withTenant(deps.db, ctx.tenantId, async (tx) =>
      readPreview(tx, ctx.tenantId, await orgAdjustmentDisclosure(tx, deps, ctx, id)),
    );
    return c.json(body, 200);
  });
}
