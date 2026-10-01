/**
 * 许可（REQ-PRM-003）：每类许可一个池（总量由平台发放），用户在一类许可上占一个名额。
 * 授予消耗许可的身份时，若该用户尚未占用此类许可则占一个（AC-PRM-08）；已占用则不再消耗（W-123）。
 */
import { and, asc, eq, licensePools, licenseSeats, sql, type Tx } from '@italent/db';
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
  // TODO(需取证 #6)：余额为 0 时原站是否阻止授权未验证（AC-PRM-09，R1-T17）；未发放 / 用尽一律先拒绝
  if (!pool || count >= pool.quota) {
    throw new AppError('CONFLICT', '许可证余额不足', { reason: 'LICENSE_EXHAUSTED', licenseType });
  }
  await tx.insert(licenseSeats).values({ ...request, consumedAt: request.now });
  return true;
}
