/**
 * 组织调整读路由（R2-T08 §9.3 路由 12～15、28，§10、§10A、§4.5；BE-10d / 10e）。
 * - 12 列表：对象查看权（无权 403）→ 主体组织按 OrganizationApproval 范围在 SQL 里先过滤再分页；列按字段查看权裁剪。
 * - 13 详情 / 14 明细 / 15 预览：同一事务内经 `orgAdjustmentDisclosure` 判一次（HR 读权 + 范围，或可打开最新审批实例），
 *   不通过与不存在同一 404 文案。只读，不进命令台账。详情另带 `employmentFailures`（人员联动失败逐人列表，F-458）。
 * - 28 架构图导出：与 15 同一判定与数据（DEC-650①：不单设权限、不注册按钮），`after` 只收 true / false，
 *   先于披露判定校验（400）；文件名日期取下载当天的租户时区日期（DEC-056）。
 */
import { withTenant } from '@italent/db';
import { MODULE_OBJECTS, ORG_ADJUSTMENT_OBJECT_CODE, tenantLocalDate } from '@italent/domain';
import type { Hono } from 'hono';
import { AppError } from '../../errors.js';
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
import { readExport } from './export-svg.js';
import { readEmploymentFailures } from './failures.js';
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
      // 范围 / 主体组织名称另按组织对象范围遮罩（F-412）
      const orgScope = await resolveModuleScopeInTransaction(bound, ctx, tx, MODULE_OBJECTS.organization.code);
      const items = (await projectHeads(tx, ctx.tenantId, rows, fields, orgScope)).map(listColumns);
      return { items, total, page: page.page, pageSize: page.pageSize };
    });
    return c.json(body, 200);
  });

  router.get(`${BASE}/:id`, async (c) => {
    const ctx = tenantOf(c);
    const id = uuidParam(c);
    const body = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const disclosure = await orgAdjustmentDisclosure(tx, deps, ctx, id);
      const detail = await readDetail(tx, ctx.tenantId, disclosure);
      return { ...detail, employmentFailures: await readEmploymentFailures(tx, deps, ctx, disclosure) };
    });
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

  router.get(`${BASE}/:id/preview/export`, async (c) => {
    const ctx = tenantOf(c);
    const id = uuidParam(c);
    const after = c.req.query('after');
    if (after !== 'true' && after !== 'false') throw new AppError('VALIDATION_FAILED', 'after 只能为 true 或 false');
    const today = tenantLocalDate(deps.clock(), ctx.timezone);
    const body = await withTenant(deps.db, ctx.tenantId, async (tx) =>
      readExport(tx, ctx.tenantId, await orgAdjustmentDisclosure(tx, deps, ctx, id), after === 'true', today),
    );
    return c.json(body, 200);
  });
}
