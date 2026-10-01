import { and, eq, tenantMemberships, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';

/** 授权对象必须是本租户的有效成员（RLS 下查不到他租户成员关系，与不存在同等处理）。 */
export async function assertActiveMember(tx: Tx, userId: string): Promise<void> {
  const [membership] = await tx
    .select({ status: tenantMemberships.status })
    .from(tenantMemberships)
    .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.status, 'active')));
  if (!membership) throw new AppError('VALIDATION_FAILED', '授权对象不是本租户的有效成员', { reason: 'NOT_A_MEMBER' });
}
