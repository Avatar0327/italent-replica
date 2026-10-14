/**
 * 企业设置 · 用户管理接口（R1-T15；DEC-128；06 §7.1「用户管理」= 租户 / 系统 / 员工 / 用户管理员，能力 user_manage）：
 *   GET  /users?type=internal|external|all&limit&offset   内部员工 / 外部用户 / 全部用户
 *   GET  /users/:userId                                    详情（ETag = 成员关系 revision）
 *   POST /users                                            登记外部用户（内部员工随建档产生，一律拒绝）
 *   PUT  /users/:userId                                    修改外部用户的业务身份（If-Match 成员关系 revision）
 *   POST /users/:userId/status                             本租户停用 / 启用（If-Match 成员关系 revision）
 *   POST /users/:userId/remove                             移出租户（If-Match 成员关系 revision）
 * DEC-142：租户侧的停用 / 移出只作用于本租户成员关系，直接调用 PR #35 的平台流程 revokeMembership（同事务经挂接点
 * 接管在途待办，DEC-123；仍是可用流程异常管理员的须先指定替代人，DEC-098），启用调用 grantMembership；账号的全局停用
 * 只由平台运营层执行。返回只含本租户成员关系，不提及该账号是否属于其他租户。
 */
import { grantMembership, revokeMembership, type TenantMembership, USER_TYPES, withTenant } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext, TenantEnv } from '../../tenant-context.js';
import { userAvatars } from '../avatar/references.js';
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
    return c.json(await currentAvatar(deps, ctx, result.body as TenantUserView), 201);
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
    return c.json(await currentAvatar(deps, ctx, result.body as TenantUserView));
  });
  registerLifecycleRoutes(router, deps);
}

function registerLifecycleRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.post(`${BASE}/:userId/status`, async (c) => {
    const { ctx, userId, expectedRevision, commandId } = await lifecycleRequest(c, deps);
    const { status } = await parseBody(c, statusBody);
    if (status === 'disabled' && userId === ctx.userId) throw selfConflict('CANNOT_DISABLE_SELF', '不能停用自己');
    const change = { tenantId: ctx.tenantId, userId, expectedRevision };
    const meta = { actorUserId: ctx.userId, commandId };
    const membership =
      status === 'disabled'
        ? await revokeMembership(deps.db, change, meta)
        : await grantMembership(deps.db, change, meta);
    return receipt(c, membership);
  });
  router.post(`${BASE}/:userId/remove`, async (c) => {
    const { ctx, userId, expectedRevision, commandId } = await lifecycleRequest(c, deps);
    if (userId === ctx.userId) throw selfConflict('CANNOT_REMOVE_SELF', '不能把自己移出租户');
    const change = { tenantId: ctx.tenantId, userId, expectedRevision };
    return receipt(c, await revokeMembership(deps.db, change, { actorUserId: ctx.userId, commandId }));
  });
}

/**
 * 生命周期命令的回执只取平台命令的结果（同键重放时即平台台账保存的首次结果），不回查当前状态，
 * 期间被其他命令改过也照样返回首次回执（astra 首审 P2-2，AGENTS.md §10「幂等」）。完整视图请 GET /users/:userId。
 */
function receipt(c: RouteContext, membership: TenantMembership) {
  etag(c, membership.revision);
  return c.json({
    userId: membership.userId,
    membershipStatus: membership.status,
    membershipRevision: membership.revision,
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

/** DEC-327：只刷新派生头像；业务身份、成员状态与 revision 仍是原命令回执。 */
async function currentAvatar(deps: TenantRouteDeps, ctx: TenantContext, receipt: TenantUserView) {
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const avatars = await userAvatars(tx, ctx.tenantId, [receipt.userId]);
    return { ...receipt, avatar: avatars.get(receipt.userId) ?? null };
  });
}

const selfConflict = (reason: string, message: string) => new AppError('CONFLICT', message, { reason });
