/**
 * 许可（REQ-PRM-003）：每类许可一个池（总量由平台发放，R1-T17），用户在一类许可上占一个名额。
 * 授予消耗许可的身份时，若该用户尚未占用此类许可则占一个（AC-PRM-08）；已占用则不再消耗（W-123）。
 * 企业设置 · 许可管理（R1-T15，06 §7.1）：余额（listBalances）与使用明细（listSeats）只读；发放不在租户侧。
 */
import { and, asc, eq, licensePools, licenseSeats, permissionGrants, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';

export interface LicenseBalance {
  readonly licenseType: string;
  readonly quota: number;
  readonly used: number;
  readonly balance: number;
  readonly revision: number;
}

export async function listBalances(tx: Tx): Promise<LicenseBalance[]> {
  const pools = await tx.select().from(licensePools).orderBy(asc(licensePools.licenseType));
  const used = await tx
    .select({ licenseType: licenseSeats.licenseType, count: sql<number>`count(*)::int` })
    .from(licenseSeats)
    .groupBy(licenseSeats.licenseType);
  return pools.map((p) => {
    const n = used.find((u) => u.licenseType === p.licenseType)?.count ?? 0;
    return { licenseType: p.licenseType, quota: p.quota, used: n, balance: p.quota - n, revision: p.revision };
  });
}

export interface SeatRequest {
  readonly tenantId: string;
  readonly licenseType: string;
  readonly userId: string;
  readonly grantId: string;
  readonly now: Date;
}

/** 返回本次是否新占了一个名额。 */
export async function consumeSeat(tx: Tx, request: SeatRequest): Promise<boolean> {
  const { licenseType, userId } = request;
  // 锁许可池行：同类许可的并发授权串行化，避免超发
  const [pool] = await tx.select().from(licensePools).where(eq(licensePools.licenseType, licenseType)).for('update');
  const [held] = await tx
    .select()
    .from(licenseSeats)
    .where(and(eq(licenseSeats.licenseType, licenseType), eq(licenseSeats.userId, userId)));
  if (held) return false;
  const [{ count } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(licenseSeats)
    .where(eq(licenseSeats.licenseType, licenseType));
  assertSeatAvailable(licenseType, pool?.quota, count);
  await tx.insert(licenseSeats).values({ ...request, consumedAt: request.now });
  return true;
}

/**
 * AC-PRM-09 的唯一判断点：余额为 0（或该类许可尚未发放）时授予消耗该类许可的身份。原站未验证（许可余额难以构造），
 * 属复刻自定，口径待编排会话登记 DEC 后定；当前按 PR“需决策”的建议：拒绝并提示余额不足，授权整单回滚。
 * TODO(需取证 #6)：撤销身份后是否归还名额原站同样未验证，暂不归还（见 revokeGrant）。
 */
function assertSeatAvailable(licenseType: string, quota: number | undefined, used: number): void {
  if (quota === undefined || used >= quota) {
    throw new AppError('CONFLICT', '许可证余额不足', { reason: 'LICENSE_EXHAUSTED', licenseType });
  }
}

export const LICENSE_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

export interface LicenseSeatView {
  readonly userId: string;
  readonly grantId: string;
  readonly profileId: string;
  readonly consumedAt: Date;
}

/** 使用明细：某类许可的名额被哪些用户、经哪条授权占用（06 §7.1「许可管理 / 使用明细」）。有界分页。 */
export async function listSeats(
  tx: Tx,
  licenseType: string,
  page: { readonly limit: number; readonly offset: number },
): Promise<LicenseSeatView[]> {
  const [pool] = LICENSE_TYPE.test(licenseType)
    ? await tx.select().from(licensePools).where(eq(licensePools.licenseType, licenseType))
    : [];
  if (!pool) throw new AppError('NOT_FOUND', '许可类型不存在');
  return tx
    .select({
      userId: licenseSeats.userId,
      grantId: licenseSeats.grantId,
      profileId: permissionGrants.profileId,
      consumedAt: licenseSeats.consumedAt,
    })
    .from(licenseSeats)
    .innerJoin(
      permissionGrants,
      and(eq(permissionGrants.tenantId, licenseSeats.tenantId), eq(permissionGrants.id, licenseSeats.grantId)),
    )
    .where(eq(licenseSeats.licenseType, licenseType))
    .orderBy(asc(licenseSeats.consumedAt), asc(licenseSeats.userId))
    .limit(page.limit)
    .offset(page.offset);
}
