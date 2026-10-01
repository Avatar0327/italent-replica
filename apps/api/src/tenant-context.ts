/**
 * 租户上下文中间件（硬规则 7；AGENTS.md §10「权限」：每次请求都在服务端重新校验成员、租户）。
 *
 * 租户取自请求头 X-Tenant-Id，而不是路径参数：租户是“会话上下文”而非资源属性，放在头里可保持
 * 资源路径稳定（/api/tenant/settings/:key），并让本中间件成为唯一的解析与校验点，路由里无从绕过。
 *
 * 校验顺序决定了对外能看到什么（docs/08_设计/R1-T00 §4）：
 * 1. 身份无效或用户非 active → 401 UNAUTHENTICATED
 * 2. 缺少 / 非法租户头 → 400 TENANT_CONTEXT_REQUIRED
 * 3. 无 active 成员关系（含租户根本不存在）→ 403 TENANT_NOT_MEMBER，不泄露租户是否存在
 * 4. 租户非 active（suspended / restoring）→ 403 TENANT_UNAVAILABLE（只有成员才会看到）
 */
import { type Db, eq, getTenant, getUser, isUuid, tenantMemberships, withTenant } from '@italent/db';
import type { Context, MiddlewareHandler } from 'hono';
import { AppError } from './errors.js';
import type { IdentityResolver } from './identity.js';

export const TENANT_HEADER = 'x-tenant-id';

export interface TenantContext {
  readonly tenantId: string;
  readonly userId: string;
  /** 租户时区（DEC-056），业务日期判定一律用它。 */
  readonly timezone: string;
}

export type TenantEnv = { Variables: { tenant: TenantContext } };

export function tenantContext(db: Db, identity: IdentityResolver): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const userId = await identity.resolve(c.req.raw);
    if (!userId || !isUuid(userId)) throw new AppError('UNAUTHENTICATED', '未登录或身份无效');
    const user = await getUser(db, userId);
    if (!user || user.status !== 'active') throw new AppError('UNAUTHENTICATED', '未登录或身份无效');

    const tenantId = c.req.header(TENANT_HEADER);
    if (!tenantId || !isUuid(tenantId)) {
      throw new AppError('TENANT_CONTEXT_REQUIRED', '缺少或非法的租户上下文（X-Tenant-Id）');
    }

    const [membership] = await withTenant(db, tenantId, (tx) =>
      tx
        .select({ status: tenantMemberships.status })
        .from(tenantMemberships)
        .where(eq(tenantMemberships.userId, userId)),
    );
    if (membership?.status !== 'active') throw new AppError('TENANT_NOT_MEMBER', '不是该租户的成员');

    const tenant = await getTenant(db, tenantId);
    if (!tenant) throw new AppError('TENANT_NOT_MEMBER', '不是该租户的成员');
    if (tenant.status !== 'active') throw new AppError('TENANT_UNAVAILABLE', '租户暂不可用');

    c.set('tenant', { tenantId, userId, timezone: tenant.timezone });
    await next();
  };
}

/** 取当前请求的租户上下文；没有经过中间件时抛错（fail-closed），不会得到“空租户”。 */
export function tenantOf(c: Context<TenantEnv>): TenantContext {
  const tenant = c.get('tenant') as TenantContext | undefined;
  if (!tenant) throw new AppError('TENANT_CONTEXT_REQUIRED', '缺少租户上下文');
  return tenant;
}
