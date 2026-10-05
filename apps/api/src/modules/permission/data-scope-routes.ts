import { withTenant } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { type TenantContext, type TenantEnv, tenantOf } from '../../tenant-context.js';
import type { WriteContext } from './audit.js';
import {
  assignUserAppScope,
  createMou,
  getMou,
  getUserAppScope,
  grantScopePrefill,
  listMous,
  updateMou,
} from './data-scope-admin.js';
import { mouBody, scopeAppCode, scopeAssignmentBody } from './data-scope-schemas.js';
import { etag, idParam, ifMatch, parseBody } from './http.js';
import { registerScopePolicyRoutes } from './scope-policy-routes.js';

const BASE = '/api/tenant/permission';
type RouteContext = Parameters<typeof tenantOf>[0];

/** REQ-PRM-002 配置边界：首版仅租户管理员配置范围，不能借现有授权能力提权。 */
export async function scopeAdminGuard(c: RouteContext, deps: TenantRouteDeps): Promise<TenantContext> {
  const ctx = tenantOf(c);
  await requirePermission(deps.authorize, { ...ctx, action: 'admin.other_settings' });
  return ctx;
}

export function scopeAdminCommand(
  c: RouteContext,
  deps: TenantRouteDeps,
  ctx: TenantContext,
  fingerprint: unknown,
  execute: (tx: Parameters<Parameters<typeof runCommand>[2]['execute']>[0], write: WriteContext) => Promise<unknown>,
  status: 200 | 201 = 200,
) {
  return runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint,
    execute: async (tx, commandId) => ({
      status,
      body: await execute(tx, {
        ...ctx,
        now: deps.clock(),
        commandId,
      }),
    }),
  });
}

function page(c: RouteContext) {
  const parsed = z
    .strictObject({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    })
    .safeParse({
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    });
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '分页超出允许范围');
  return parsed.data;
}

function appParam(c: RouteContext) {
  const app = scopeAppCode.safeParse(c.req.param('appCode'));
  if (!app.success) throw new AppError('NOT_FOUND', '应用不存在');
  return app.data;
}

export function registerDataScopeRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerScopePolicyRoutes(router, deps);
  mouRoutes(router, deps);
  assignmentRoutes(router, deps);
}

/**
 * 企业设置 · 管理单元（R1-T15，06 §7.1）：租户 / 系统 / 用户 / 权限管理员可查看（mou_manage）；
 * 增删改首版只开放给租户管理员（REQ-PRM-002「配置边界」，other_settings）。
 */
async function mouViewGuard(c: RouteContext, deps: TenantRouteDeps): Promise<TenantContext> {
  const ctx = tenantOf(c);
  await requirePermission(deps.authorize, { ...ctx, action: 'admin.mou_manage' });
  return ctx;
}

function mouRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${BASE}/mous`, async (c) => {
    const ctx = await mouViewGuard(c, deps);
    const paging = page(c);
    return c.json({ items: await withTenant(deps.db, ctx.tenantId, (tx) => listMous(tx, paging)) });
  });
  router.get(`${BASE}/mous/:id`, async (c) => {
    const ctx = await mouViewGuard(c, deps);
    const mou = await withTenant(deps.db, ctx.tenantId, (tx) => getMou(tx, idParam(c, 'id')));
    etag(c, mou.revision);
    return c.json(mou);
  });
  router.post(`${BASE}/mous`, async (c) => {
    const ctx = await scopeAdminGuard(c, deps);
    const body = await parseBody(c, mouBody);
    const expectedRevision = ifMatch(c);
    const result = await scopeAdminCommand(
      c,
      deps,
      ctx,
      { action: 'mou.create', body, expectedRevision },
      (tx, write) => createMou(tx, write, body, expectedRevision),
      201,
    );
    return c.json(result.body, 201);
  });
  router.put(`${BASE}/mous/:id`, async (c) => {
    const ctx = await scopeAdminGuard(c, deps);
    const id = idParam(c, 'id');
    const body = await parseBody(c, mouBody);
    const expectedRevision = ifMatch(c);
    const result = await scopeAdminCommand(
      c,
      deps,
      ctx,
      { action: 'mou.update', id, body, expectedRevision },
      (tx, write) => updateMou(tx, write, id, expectedRevision, body),
    );
    etag(c, (result.body as { revision: number }).revision);
    return c.json(result.body);
  });
  router.delete(`${BASE}/mous/:id`, async (c) => {
    const ctx = await scopeAdminGuard(c, deps);
    const id = idParam(c, 'id');
    const expectedRevision = ifMatch(c);
    const result = await scopeAdminCommand(c, deps, ctx, { action: 'mou.delete', id, expectedRevision }, (tx, write) =>
      updateMou(tx, write, id, expectedRevision, null),
    );
    return c.json(result.body);
  });
}

function assignmentRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${BASE}/scopes/:userId/:appCode`, async (c) => {
    const ctx = await scopeAdminGuard(c, deps);
    const userId = idParam(c, 'userId');
    const appCode = appParam(c);
    const scope = await withTenant(deps.db, ctx.tenantId, (tx) => getUserAppScope(tx, userId, appCode));
    etag(c, scope.revision);
    return c.json(scope);
  });
  router.put(`${BASE}/scopes/:userId/:appCode`, async (c) => {
    const ctx = await scopeAdminGuard(c, deps);
    const userId = idParam(c, 'userId');
    const appCode = appParam(c);
    const expectedRevision = ifMatch(c);
    const body = await parseBody(c, scopeAssignmentBody);
    const result = await scopeAdminCommand(
      c,
      deps,
      ctx,
      { action: 'scope.assign', userId, appCode, body, expectedRevision },
      (tx, write) => assignUserAppScope(tx, write, userId, appCode, expectedRevision, body),
    );
    etag(c, (result.body as { revision: number }).revision);
    return c.json(result.body);
  });
  router.get(`${BASE}/grant-prefill/:userId/:profileId`, async (c) => {
    const ctx = await scopeAdminGuard(c, deps);
    return c.json(
      await withTenant(deps.db, ctx.tenantId, (tx) =>
        grantScopePrefill(tx, idParam(c, 'userId'), idParam(c, 'profileId')),
      ),
    );
  });
}
