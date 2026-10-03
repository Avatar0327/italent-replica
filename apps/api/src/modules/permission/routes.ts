/**
 * 权限接口（R1-T01）。全部在 /api/tenant/permission 之下，经租户上下文中间件；写请求带 Idempotency-Key，
 * 修改已有对象带 If-Match（revision）。企业设置类接口按 8 类管理员能力鉴权（06 §7.1）：
 *   身份      GET/POST /profiles、GET /profiles/:id、PUT /profiles/:id/objects/:objectCode   profile_manage
 *   用户授权  GET /grantable-profiles、GET/POST /grants、POST /grants/:id/revoke             user_grant
 *   管理员    GET/POST /admins、GET/PUT /admins/:id                                         admin_manage
 *   许可      GET /licenses                                                                license_balance
 *   本人      GET /me/objects/:objectCode  当前用户对某对象的有效功能权限（前台按它显示按钮、列与字段）
 * TODO(需取证 #4)：菜单上下文是否参与后端鉴权（AC-PRM-02 与 AC-PRM-24 冲突）；当前只按身份与管理员能力判定。
 */
import { withTenant } from '@italent/db';
import type { Hono } from 'hono';
import { requirePermission } from '../../authorization.js';
import { runCommand } from '../../commands.js';
import type { BodyLimitOverride } from '../../middleware.js';
import type { TenantRouteDeps } from '../../routes.js';
import { type TenantContext, type TenantEnv, tenantOf } from '../../tenant-context.js';
import { createAdmin, getAdmin, listAdmins, updateAdmin } from './admins.js';
import type { WriteContext } from './audit.js';
import { registerDataScopeRoutes } from './data-scope-routes.js';
import { objectCatalog } from './catalog.js';
import { createGrant, grantableProfiles, listGrants, revokeGrant } from './grants.js';
import { etag, idParam, ifMatch, objectCodeParam, parseBody } from './http.js';
import { listBalances } from './licenses.js';
import { myObjectPermission } from './me.js';
import { createProfile, getProfileDetail, listProfiles, setObjectPermission } from './profiles.js';
import { adminBody, adminSetsBody, grantBody, grantQuery, objectPermissionBody, profileBody } from './schemas.js';

const BASE = '/api/tenant/permission';

/**
 * 身份对象权限按“整对象替换”提交（一次给出全部字段与按钮，保证原子与 revision 语义），
 * 原站任职记录一个对象就有 274 字段、349 按钮（06 §7.2），载荷约 40KB，超过默认 32KB。
 * 结构校验上限为字段、按钮各 1000 条、编码 ≤128 字符（schemas.ts），紧凑 JSON 最大约 340KB；
 * 放宽到 512KB，仍是有界上限。只对这一个 PUT 生效，其余权限接口仍是默认 32KB。
 */
export const OBJECT_PERMISSION_BODY_LIMIT = 512 * 1024;
export const PERMISSION_BODY_LIMITS: readonly BodyLimitOverride[] = [
  {
    method: 'PUT',
    path: /^\/api\/tenant\/permission\/profiles\/[^/]+\/objects\/[^/]+$/,
    maxSize: OBJECT_PERMISSION_BODY_LIMIT,
  },
];

type Router = Hono<TenantEnv>;

export function registerPermissionRoutes(router: Router, deps: TenantRouteDeps): void {
  registerDataScopeRoutes(router, deps);
  profileRoutes(router, deps);
  grantRoutes(router, deps);
  adminRoutes(router, deps);
  router.get(`${BASE}/licenses`, async (c) => {
    const ctx = await guard(c, deps, 'license_balance');
    return c.json({ items: await withTenant(deps.db, ctx.tenantId, listBalances) });
  });
  router.get(`${BASE}/me/objects/:objectCode`, async (c) => {
    const { tenantId, userId } = tenantOf(c);
    const objectCode = objectCodeParam(c);
    return c.json(
      await withTenant(deps.db, tenantId, (tx) => myObjectPermission(tx, userId, objectCode, objectCatalog)),
    );
  });
}

function profileRoutes(router: Router, deps: TenantRouteDeps): void {
  router.get(`${BASE}/profiles`, async (c) => {
    const ctx = await guard(c, deps, 'profile_manage');
    return c.json({ items: await withTenant(deps.db, ctx.tenantId, listProfiles) });
  });
  router.get(`${BASE}/profiles/:id`, async (c) => {
    const ctx = await guard(c, deps, 'profile_manage');
    const detail = await withTenant(deps.db, ctx.tenantId, (tx) => getProfileDetail(tx, idParam(c, 'id')));
    etag(c, detail.revision);
    return c.json(detail);
  });
  router.post(`${BASE}/profiles`, async (c) => {
    const ctx = await guard(c, deps, 'profile_manage');
    const body = await parseBody(c, profileBody);
    const result = await command(
      c,
      deps,
      ctx,
      { op: 'profile.create', body },
      (tx, w) => createProfile(tx, w, body),
      201,
    );
    return c.json(result.body, 201);
  });
  router.put(`${BASE}/profiles/:id/objects/:objectCode`, async (c) => {
    const ctx = await guard(c, deps, 'profile_manage');
    const profileId = idParam(c, 'id');
    const objectCode = objectCodeParam(c);
    const expectedRevision = ifMatch(c);
    const body = await parseBody(c, objectPermissionBody);
    const change = { profileId, expectedRevision, permission: { objectCode, ...body } };
    const result = await command(c, deps, ctx, { op: 'profile.set_object', change }, (tx, w) =>
      setObjectPermission(tx, w, objectCatalog, change),
    );
    etag(c, (result.body as { revision: number }).revision);
    return c.json(result.body);
  });
}

function grantRoutes(router: Router, deps: TenantRouteDeps): void {
  router.get(`${BASE}/grantable-profiles`, async (c) => {
    const ctx = await guard(c, deps, 'user_grant');
    return c.json({ items: await withTenant(deps.db, ctx.tenantId, (tx) => grantableProfiles(tx, ctx.userId)) });
  });
  router.get(`${BASE}/grants`, async (c) => {
    const ctx = await guard(c, deps, 'user_grant');
    const { userId } = grantQuery.parse({ userId: c.req.query('userId') });
    return c.json({ items: await withTenant(deps.db, ctx.tenantId, (tx) => listGrants(tx, userId)) });
  });
  router.post(`${BASE}/grants`, async (c) => {
    const ctx = await guard(c, deps, 'user_grant');
    const body = await parseBody(c, grantBody);
    if (body.scopes?.length) await requirePermission(deps.authorize, { ...ctx, action: 'admin.other_settings' });
    const result = await command(c, deps, ctx, { op: 'grant.create', body }, (tx, w) => createGrant(tx, w, body), 201);
    return c.json(result.body, 201);
  });
  router.post(`${BASE}/grants/:id/revoke`, async (c) => {
    const ctx = await guard(c, deps, 'user_grant');
    const change = { grantId: idParam(c, 'id'), expectedRevision: ifMatch(c) };
    const result = await command(c, deps, ctx, { op: 'grant.revoke', change }, (tx, w) => revokeGrant(tx, w, change));
    return c.json(result.body);
  });
}

function adminRoutes(router: Router, deps: TenantRouteDeps): void {
  router.get(`${BASE}/admins`, async (c) => {
    const ctx = await guard(c, deps, 'admin_manage');
    return c.json({ items: await withTenant(deps.db, ctx.tenantId, listAdmins) });
  });
  router.get(`${BASE}/admins/:id`, async (c) => {
    const ctx = await guard(c, deps, 'admin_manage');
    const admin = await withTenant(deps.db, ctx.tenantId, (tx) => getAdmin(tx, idParam(c, 'id')));
    etag(c, admin.revision);
    return c.json(admin);
  });
  router.post(`${BASE}/admins`, async (c) => {
    const ctx = await guard(c, deps, 'admin_manage');
    const body = await parseBody(c, adminBody);
    const result = await command(c, deps, ctx, { op: 'admin.create', body }, (tx, w) => createAdmin(tx, w, body), 201);
    return c.json(result.body, 201);
  });
  router.put(`${BASE}/admins/:id`, async (c) => {
    const ctx = await guard(c, deps, 'admin_manage');
    const change = { adminId: idParam(c, 'id'), expectedRevision: ifMatch(c), ...(await parseBody(c, adminSetsBody)) };
    const result = await command(c, deps, ctx, { op: 'admin.update', change }, (tx, w) => updateAdmin(tx, w, change));
    etag(c, (result.body as { revision: number }).revision);
    return c.json(result.body);
  });
}

type RouteContext = Parameters<typeof tenantOf>[0];

async function guard(c: RouteContext, deps: TenantRouteDeps, capability: string): Promise<TenantContext> {
  const ctx = tenantOf(c);
  await requirePermission(deps.authorize, { ...ctx, action: `admin.${capability}` });
  return ctx;
}

/** 写命令：同一租户事务内完成业务写 + 审计 + 命令台账（runCommand）。 */
function command(
  c: RouteContext,
  deps: TenantRouteDeps,
  ctx: TenantContext,
  fingerprint: unknown,
  run: (tx: Parameters<Parameters<typeof runCommand>[2]['execute']>[0], write: WriteContext) => Promise<unknown>,
  status: 200 | 201 = 200,
) {
  return runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint,
    execute: async (tx, commandId) => {
      const write: WriteContext = { tenantId: ctx.tenantId, userId: ctx.userId, now: deps.clock(), commandId };
      return { status, body: await run(tx, write) };
    },
  });
}
