/**
 * 平台接口的准入中间件（REQ-PLT-001 R1、R4；R1-T17）：只认平台运营身份，与租户内权限完全隔离——
 * 不读 X-Tenant-Id、不看任何租户成员关系或企业管理员身份；每次请求都重新校验账号与平台运营身份（撤销立即生效）。
 * 1. 身份无效或账号非 active → 401 UNAUTHENTICATED
 * 2. 不是有效的平台运营身份 → 403 FORBIDDEN（reason = PLATFORM_OPERATOR_REQUIRED）
 */
import { type Db, getUser, isActivePlatformOperator, isUuid } from '@italent/db';
import type { Context, MiddlewareHandler } from 'hono';
import { AppError } from '../../errors.js';
import type { IdentityResolver } from '../../identity.js';

export interface PlatformOperatorContext {
  readonly userId: string;
}

export type PlatformEnv = { Variables: { operator: PlatformOperatorContext } };

export function platformContext(db: Db, identity: IdentityResolver): MiddlewareHandler<PlatformEnv> {
  return async (c, next) => {
    const userId = await identity.resolve(c.req.raw);
    if (!userId || !isUuid(userId)) throw new AppError('UNAUTHENTICATED', '未登录或身份无效');
    const user = await getUser(db, userId);
    if (!user || user.status !== 'active') throw new AppError('UNAUTHENTICATED', '未登录或身份无效');
    if (!(await isActivePlatformOperator(db, userId))) {
      throw new AppError('FORBIDDEN', '仅平台运营身份可调用平台接口', { reason: 'PLATFORM_OPERATOR_REQUIRED' });
    }
    c.set('operator', { userId });
    await next();
  };
}

export function operatorOf(c: Context<PlatformEnv>): PlatformOperatorContext {
  const operator = c.get('operator') as PlatformOperatorContext | undefined;
  if (!operator) throw new AppError('FORBIDDEN', '仅平台运营身份可调用平台接口');
  return operator;
}
