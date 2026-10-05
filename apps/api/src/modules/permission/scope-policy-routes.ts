import { type Tx, withTenant } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import type { WriteContext } from './audit.js';
import { scopeAdminCommand, scopeAdminGuard } from './data-scope-routes.js';
import { scopeAppCode } from './data-scope-schemas.js';
import { etag, idParam, ifMatch, parseBody } from './http.js';
import {
  dynamicOrgBody,
  getDynamicOrgGrant,
  getIdentityScope,
  getPersonLink,
  getScopeApp,
  getScopePolicy,
  identityScopeBody,
  scopeAppBody,
  scopePolicyBody,
  scopePolicyKey,
  setDynamicOrgGrant,
  setIdentityScope,
  setScopeApp,
  setScopePolicy,
} from './scope-policy-service.js';

const BASE = '/api/tenant/permission';
type RouteContext = Parameters<typeof scopeAdminGuard>[0];
function appParam(c: RouteContext) {
  const result = scopeAppCode.safeParse(c.req.param('appCode'));
  if (!result.success) throw new AppError('NOT_FOUND', '应用不存在');
  return result.data;
}

export function registerScopePolicyRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  identityRoutes(router, deps);
  configRoutes(router, deps, {
    path: `${BASE}/scope-apps/:appCode`,
    key: appParam,
    body: scopeAppBody,
    get: getScopeApp,
    put: setScopeApp,
  });
  personLinkRoutes(router, deps);
  configRoutes(router, deps, {
    path: `${BASE}/dynamic-org-grants/:grantId`,
    key: (c) => idParam(c, 'grantId'),
    body: dynamicOrgBody,
    get: getDynamicOrgGrant,
    put: (tx, write, key, body, revision) => setDynamicOrgGrant(tx, write, key, body.roleCode, revision),
    remove: (tx, write, key, revision) => setDynamicOrgGrant(tx, write, key, null, revision),
  });
  configRoutes(router, deps, {
    path: `${BASE}/scope-policies/:appCode/:objectCode/:targetKind/:targetCode`,
    key: policyKey,
    body: scopePolicyBody,
    get: getScopePolicy,
    put: setScopePolicy,
  });
}

/**
 * 用户与人员的绑定（DEC-128，AC-PRM-32）：只由建档 / 入职写入（user-provisioning.ts），这里只读；
 * 手工绑定、改绑、解绑一律拒绝（原站没有“先建账号、再绑人”的入口，06 §9）。
 */
function personLinkRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const path = `${BASE}/person-links/:userId`;
  router.get(path, async (c) => {
    const ctx = await scopeAdminGuard(c, deps);
    const userId = idParam(c, 'userId');
    const link = await withTenant(deps.db, ctx.tenantId, (tx) => getPersonLink(tx, userId));
    etag(c, link.revision);
    return c.json(link);
  });
  const rejected = () => {
    throw new AppError('FORBIDDEN', '用户与人员的绑定随人员档案自动产生，不能手工绑定或改绑', {
      reason: 'USER_BINDING_BY_PROFILE',
    });
  };
  router.put(path, rejected);
  router.delete(path, rejected);
}

function policyKey(c: RouteContext) {
  const parsed = scopePolicyKey.safeParse({
    appCode: appParam(c),
    objectCode: c.req.param('objectCode'),
    targetKind: c.req.param('targetKind'),
    targetCode: c.req.param('targetCode'),
  });
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '数据权限目标不合法');
  return parsed.data;
}

interface ConfigRoutes<Key, Schema extends z.ZodType> {
  path: string;
  key(c: RouteContext): Key;
  body: Schema;
  get(tx: Tx, key: Key): Promise<{ revision: number }>;
  put(tx: Tx, write: WriteContext, key: Key, body: z.output<Schema>, revision: number): Promise<{ revision: number }>;
  remove?(tx: Tx, write: WriteContext, key: Key, revision: number): Promise<{ revision: number }>;
}

/** 仅复用HTTP命令边界；各对象的正表、约束与写入逻辑仍在各自明确的服务函数中。 */
function configRoutes<Key, Schema extends z.ZodType>(
  router: Hono<TenantEnv>,
  deps: TenantRouteDeps,
  config: ConfigRoutes<Key, Schema>,
) {
  router.get(config.path, async (c) => {
    const ctx = await scopeAdminGuard(c, deps);
    const key = config.key(c);
    const body = await withTenant(deps.db, ctx.tenantId, (tx) => config.get(tx, key));
    etag(c, body.revision);
    return c.json(body);
  });
  router.put(config.path, async (c) => {
    const ctx = await scopeAdminGuard(c, deps);
    const key = config.key(c);
    const body = await parseBody(c, config.body);
    const revision = ifMatch(c);
    const result = await scopeAdminCommand(c, deps, ctx, { action: config.path, key, body, revision }, (tx, write) =>
      config.put(tx, write, key, body, revision),
    );
    etag(c, (result.body as { revision: number }).revision);
    return c.json(result.body);
  });
  if (config.remove)
    router.delete(config.path, async (c) => {
      const ctx = await scopeAdminGuard(c, deps);
      const key = config.key(c);
      await parseBody(c, z.strictObject({}));
      const revision = ifMatch(c);
      const result = await scopeAdminCommand(
        c,
        deps,
        ctx,
        { action: `${config.path}.delete`, key, revision },
        (tx, write) => config.remove!(tx, write, key, revision),
      );
      etag(c, (result.body as { revision: number }).revision);
      return c.json(result.body);
    });
}

function identityRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const path = `${BASE}/profiles/:id/data-scopes/:appCode`;
  router.get(path, async (c) => {
    const ctx = await scopeAdminGuard(c, deps);
    const target = identityScopeBody.omit({ seeAll: true }).safeParse({
      targetKind: c.req.query('targetKind') ?? 'app',
      targetCode: c.req.query('targetCode') ?? '',
    });
    if (!target.success) throw new AppError('VALIDATION_FAILED', '数据权限目标不合法');
    const key = { profileId: idParam(c, 'id'), appCode: appParam(c), ...target.data };
    const result = await withTenant(deps.db, ctx.tenantId, (tx) => getIdentityScope(tx, key));
    etag(c, result.revision);
    return c.json(result);
  });
  router.put(path, async (c) => {
    const ctx = await scopeAdminGuard(c, deps);
    const body = await parseBody(c, identityScopeBody);
    const { seeAll, ...target } = body;
    const key = { profileId: idParam(c, 'id'), appCode: appParam(c), ...target };
    const expectedRevision = ifMatch(c);
    const result = await scopeAdminCommand(
      c,
      deps,
      ctx,
      { action: 'scope.identity', key, seeAll, expectedRevision },
      (tx, write) => setIdentityScope(tx, write, key, seeAll, expectedRevision),
    );
    etag(c, (result.body as { revision: number }).revision);
    return c.json(result.body);
  });
}
