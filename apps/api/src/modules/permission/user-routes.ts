/**
 * 企业设置 · 用户管理接口（R1-T15；DEC-128；06 §7.1「用户管理」= 租户 / 系统 / 员工 / 用户管理员，能力 user_manage）：
 *   GET  /users?type=internal|external|all&limit&offset   内部员工 / 外部用户 / 全部用户
 *   GET  /users/:userId                                    详情（ETag = 成员关系 revision）
 *   POST /users                                            登记外部用户（内部员工随建档产生，一律拒绝）
 *   PUT  /users/:userId                                    修改外部用户的业务身份（If-Match 成员关系 revision）
 *   POST /users/:userId/status                             停用 / 启用账号（If-Match 账号 revision）→ 平台 setUserStatus
 *   POST /users/:userId/remove                             移出租户（If-Match 成员关系 revision）→ 平台 revokeMembership
 * 停用与移出租户直接调用 PR #35 的平台流程：同事务经挂接点接管在途待办（DEC-123），仍是可用流程异常管理员的
 * 须先指定替代人（DEC-098），审计由平台流程写入本租户。
 */
import { AccountScopeError, revokeMembership, setUserStatus, USER_TYPES, withTenant } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext, TenantEnv } from '../../tenant-context.js';
import { adminCommand, adminGuard, platformCommandId, type RouteContext } from './admin-http.js';
import { etag, idParam, ifMatch, parseBody } from './http.js';
import {
  getTenantUser,
  internalUserByProfile,
  listTenantUsers,
  registerExternalUser,
  type TenantUserView,
  updateExternalUser,
} from './tenant-users.js';

const BASE = '/api/tenant/permission/users';
const CAPABILITY = 'user_manage';

const businessIdentity = z.string().trim().min(1).max(50);
const registerBody = z.strictObject({
  email: z.email().max(320),
  displayName: z.string().trim().min(1).max(100),
  userType: z.enum(USER_TYPES),
  businessIdentity: businessIdentity.optional(),
});
const updateBody = z.strictObject({ userType: z.enum(USER_TYPES), businessIdentity });
const statusBody = z.strictObject({ status: z.enum(['active', 'disabled']) });
const listQuery = z.strictObject({
  type: z.enum(['internal', 'external', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export function registerUserRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(BASE, async (c) => {
    const ctx = await adminGuard(c, deps, CAPABILITY);
    const parsed = listQuery.safeParse({
      type: c.req.query('type'),
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    });
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '查询参数不合法', parsed.error.issues);
    return c.json({ items: await withTenant(deps.db, ctx.tenantId, (tx) => listTenantUsers(tx, parsed.data)) });
  });
  router.get(`${BASE}/:userId`, async (c) => {
    const ctx = await adminGuard(c, deps, CAPABILITY);
    const user = await currentUser(deps, ctx, idParam(c, 'userId'));
    etag(c, user.membershipRevision);
    return c.json(user);
  });
  router.post(BASE, async (c) => {
    const ctx = await adminGuard(c, deps, CAPABILITY);
    const body = await parseBody(c, registerBody);
    if (body.userType === 'internal') throw internalUserByProfile();
    if (!body.businessIdentity) throw new AppError('VALIDATION_FAILED', '外部用户必须指定业务身份');
    const input = { email: body.email, displayName: body.displayName, businessIdentity: body.businessIdentity };
    const result = await adminCommand(
      c,
      deps,
      ctx,
      { op: 'tenant_user.register_external', input },
      (tx, w) => registerExternalUser(tx, w, input),
      201,
    );
    return c.json(result.body, 201);
  });
  router.put(`${BASE}/:userId`, async (c) => {
    const ctx = await adminGuard(c, deps, CAPABILITY);
    const userId = idParam(c, 'userId');
    const expectedRevision = ifMatch(c);
    const body = await parseBody(c, updateBody);
    if (body.userType === 'internal') throw internalUserByProfile();
    const change = { userId, expectedRevision, businessIdentity: body.businessIdentity };
    const result = await adminCommand(c, deps, ctx, { op: 'tenant_user.update', change }, (tx, w) =>
      updateExternalUser(tx, w, change),
    );
    etag(c, (result.body as TenantUserView).membershipRevision);
    return c.json(result.body);
  });
  registerLifecycleRoutes(router, deps);
}

function registerLifecycleRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.post(`${BASE}/:userId/status`, async (c) => {
    const { ctx, userId, expectedRevision, commandId } = await lifecycleRequest(c, deps);
    const { status } = await parseBody(c, statusBody);
    if (userId === ctx.userId) throw selfConflict('CANNOT_DISABLE_SELF', '不能停用或启用自己的账号');
    const change = { userId, status, expectedRevision, onlyTenantId: ctx.tenantId };
    await platform(() => setUserStatus(deps.db, change, { actorUserId: ctx.userId, commandId }));
    return c.json(await currentUser(deps, ctx, userId));
  });
  router.post(`${BASE}/:userId/remove`, async (c) => {
    const { ctx, userId, expectedRevision, commandId } = await lifecycleRequest(c, deps);
    if (userId === ctx.userId) throw selfConflict('CANNOT_REMOVE_SELF', '不能把自己移出租户');
    const change = { tenantId: ctx.tenantId, userId, expectedRevision };
    await platform(() => revokeMembership(deps.db, change, { actorUserId: ctx.userId, commandId }));
    const user = await currentUser(deps, ctx, userId);
    etag(c, user.membershipRevision);
    return c.json(user);
  });
}

/** 停用 / 移出的公共前置：用户管理能力、本租户用户（他租户用户与不存在同样 404）、revision、命令 ID。 */
async function lifecycleRequest(c: RouteContext, deps: TenantRouteDeps) {
  const ctx = await adminGuard(c, deps, CAPABILITY);
  const userId = idParam(c, 'userId');
  const expectedRevision = ifMatch(c);
  const commandId = platformCommandId(c, ctx);
  await currentUser(deps, ctx, userId);
  return { ctx, userId, expectedRevision, commandId };
}

function currentUser(deps: TenantRouteDeps, ctx: TenantContext, userId: string): Promise<TenantUserView> {
  return withTenant(deps.db, ctx.tenantId, (tx) => getTenantUser(tx, userId));
}

const selfConflict = (reason: string, message: string) => new AppError('CONFLICT', message, { reason });

async function platform<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof AccountScopeError)) throw error;
    if (error.reason === 'NOT_A_MEMBER') throw new AppError('NOT_FOUND', '用户不存在');
    throw new AppError('CONFLICT', error.message, { reason: error.reason });
  }
}
