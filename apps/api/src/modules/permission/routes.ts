import { tenantLocalDate } from '@italent/domain';
/**
 * 权限接口（R1-T01；企业设置 R1-T15）。全部在 /api/tenant/permission 之下，经租户上下文中间件；写请求带
 * Idempotency-Key，修改已有对象带 If-Match（revision）。企业设置类接口按 8 类管理员能力鉴权（06 §7.1）：
 *   身份      GET/POST /profiles、GET /profiles/:id、PUT /profiles/:id/objects/:objectCode   profile_manage
 *   用户授权  GET /grantable-profiles、GET/POST /grants、POST /grants/:id/revoke             user_grant
 *   管理员    GET/POST /admins、GET/PUT /admins/:id                                         admin_manage
 *   用户管理  /users…（见 user-routes.ts）                                                  user_manage
 *   管理单元  GET /mous、GET /mous/:id；增删改见 data-scope-routes.ts                     mou_manage / other_settings
 *   许可      GET /licenses                                                                license_balance
 *             GET /licenses/:licenseType/seats（使用明细）                                   license_usage
 *   菜单      GET /admin-menus  当前用户可见的企业设置菜单及可操作性（06 §7.1 矩阵）
 *   本人      GET /me/objects/:objectCode  当前用户对某对象的有效功能权限（前台按它显示按钮、列与字段）
 * TODO(需取证 #4)：菜单上下文是否参与后端鉴权（AC-PRM-02 与 AC-PRM-24 冲突）；当前只按身份与管理员能力判定。
 */
import { withTenant } from '@italent/db';
import { ADMIN_ROLE_NAMES, ADMIN_ROLES, visibleEnterpriseMenus } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { BodyLimitOverride } from '../../middleware.js';
import type { TenantRouteDeps } from '../../routes.js';
import { type TenantEnv, tenantOf } from '../../tenant-context.js';
import { adminCommand as command, adminGuard as guard } from './admin-http.js';
import { createAdmin, getAdmin, listAdmins, updateAdmin } from './admins.js';
import { registerDataScopeRoutes } from './data-scope-routes.js';
import { objectCatalog } from './catalog.js';
import { createGrant, grantableProfiles, listGrants, revokeGrant } from './grants.js';
import { etag, idParam, ifMatch, objectCodeParam, parseBody } from './http.js';
import { listBalances, listSeats } from './licenses.js';
import { myObjectPermission } from './me.js';
import { createProfile, getProfileDetail, listProfiles, setObjectPermission } from './profiles.js';
import { adminBody, adminSetsBody, grantBody, grantQuery, objectPermissionBody, profileBody } from './schemas.js';
import { loadAdminRoles } from './subject.js';
import { registerUserRoutes } from './user-routes.js';

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
  registerUserRoutes(router, deps);
  profileRoutes(router, deps);
  grantRoutes(router, deps);
  adminRoutes(router, deps);
  licenseRoutes(router, deps);
  // AC-TEN-04：8 类企业管理员身份是平台预置的固定身份（06 §7.1），管理员管理页据此列出
  router.get(`${BASE}/admin-roles`, async (c) => {
    await guard(c, deps, 'admin_manage');
    return c.json({ items: ADMIN_ROLES.map((role) => ({ role, name: ADMIN_ROLE_NAMES[role] })) });
  });
  router.get(`${BASE}/admin-menus`, async (c) => {
    const { tenantId, userId } = tenantOf(c);
    const roles = await withTenant(deps.db, tenantId, (tx) => loadAdminRoles(tx, userId));
    return c.json({ items: visibleEnterpriseMenus(roles) });
  });
  router.get(`${BASE}/me/objects/:objectCode`, async (c) => {
    const { tenantId, userId } = tenantOf(c);
    const objectCode = objectCodeParam(c);
    return c.json(
      await withTenant(deps.db, tenantId, (tx) =>
        myObjectPermission(tx, userId, objectCode, objectCatalog, {
          tenantId,
          userId,
          asOf: tenantLocalDate(deps.clock(), tenantOf(c).timezone),
        }),
      ),
    );
  });
}

const seatPage = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

function licenseRoutes(router: Router, deps: TenantRouteDeps): void {
  router.get(`${BASE}/licenses`, async (c) => {
    const ctx = await guard(c, deps, 'license_balance');
    return c.json({ items: await withTenant(deps.db, ctx.tenantId, listBalances) });
  });
  router.get(`${BASE}/licenses/:licenseType/seats`, async (c) => {
    const ctx = await guard(c, deps, 'license_usage');
    const page = seatPage.safeParse({ limit: c.req.query('limit'), offset: c.req.query('offset') });
    if (!page.success) throw new AppError('VALIDATION_FAILED', '分页超出允许范围');
    const licenseType = c.req.param('licenseType');
    return c.json({ items: await withTenant(deps.db, ctx.tenantId, (tx) => listSeats(tx, licenseType, page.data)) });
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
    const { catalogDigest, ...permission } = body;
    const change = {
      profileId,
      expectedRevision,
      permission: { objectCode, ...permission },
      ...(catalogDigest === undefined ? {} : { catalogDigest }),
    };
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
