/**
 * 许可（REQ-PRM-003）：每类许可一个池（总量由平台发放，R1-T17），用户在一类许可上占一个名额。
 * 授予消耗许可的身份时，若该用户尚未占用此类许可则占一个（AC-PRM-08）；已占用则不再消耗（W-123）。
 * 余额为 0 或尚未发放时照常授予、余额记为负数并提示超额（DEC-143）；撤销后不再持有同类授权即归还名额（DEC-141）。
 * 企业设置 · 许可管理（R1-T15，06 §7.1）：余额（listBalances）与使用明细（listSeats）只读；发放不在租户侧。
 */
import {
  and,
  asc,
  eq,
  licensePools,
  licenseSeats,
  ne,
  permissionGrants,
  permissionProfiles,
  sql,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';

export interface LicenseBalance {
  readonly licenseType: string;
  readonly quota: number;
  readonly used: number;
  readonly balance: number;
  /** 余额为负：已授出的名额超过发放总量，待平台补发（DEC-143）。 */
  readonly overage: boolean;
  /** 许可池的 revision；尚未发放（只有超额占用）时为 0。 */
  readonly revision: number;
}

/** 授权响应里的可机读超额提示（DEC-143）。 */
export interface LicenseOverage {
  readonly code: 'LICENSE_OVERAGE';
  readonly licenseType: string;
  readonly quota: number;
  readonly used: number;
  readonly balance: number;
}

/** 已发放的许可池，加上未发放却已有占用的类型（总量按 0 计）。 */
export async function listBalances(tx: Tx): Promise<LicenseBalance[]> {
  const pools = await tx.select().from(licensePools);
  const used = await tx
    .select({ licenseType: licenseSeats.licenseType, count: sql<number>`count(*)::int` })
    .from(licenseSeats)
    .groupBy(licenseSeats.licenseType);
  const types = [...new Set([...pools.map((p) => p.licenseType), ...used.map((u) => u.licenseType)])].sort();
  return types.map((licenseType) => {
    const pool = pools.find((p) => p.licenseType === licenseType);
    const quota = pool?.quota ?? 0;
    const n = used.find((u) => u.licenseType === licenseType)?.count ?? 0;
    return { licenseType, quota, used: n, balance: quota - n, overage: quota < n, revision: pool?.revision ?? 0 };
  });
}

export interface SeatRequest {
  readonly tenantId: string;
  readonly licenseType: string;
  readonly userId: string;
  readonly grantId: string;
  readonly now: Date;
}

export interface SeatOutcome {
  /** 本次是否新占了一个名额。 */
  readonly consumed: boolean;
  /** 授予后该类许可的超额提示（不论本次是否新占名额，DEC-143）；未超额为 null。 */
  readonly overage: LicenseOverage | null;
}

/**
 * 同类许可的占用、归还串行化（许可池可能尚未发放，不能只靠锁池行）。
 * 取锁顺序：先取本锁，再锁授权行——撤销时名额改记到同类另一条授权要对那条授权取外键共享锁，
 * 两笔撤销若先各自锁授权行再争本锁会形成死锁环（revokeGrant 据此先取本锁）。
 */
export async function lockLicenseType(tx: Tx, tenantId: string, licenseType: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:license:${licenseType}`}, 0))`);
}

export async function consumeSeat(tx: Tx, request: SeatRequest): Promise<SeatOutcome> {
  const { tenantId, licenseType, userId } = request;
  await lockLicenseType(tx, tenantId, licenseType);
  const [held] = await tx
    .select()
    .from(licenseSeats)
    .where(and(eq(licenseSeats.licenseType, licenseType), eq(licenseSeats.userId, userId)));
  // 已占名额不再消耗（W-123），但仍按当前余额提示超额：与余额接口的 overage 一致
  if (!held) await tx.insert(licenseSeats).values({ ...request, consumedAt: request.now });
  return { consumed: !held, overage: await currentOverage(tx, licenseType) };
}

async function currentOverage(tx: Tx, licenseType: string): Promise<LicenseOverage | null> {
  const [pool] = await tx.select().from(licensePools).where(eq(licensePools.licenseType, licenseType));
  const [{ count } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(licenseSeats)
    .where(eq(licenseSeats.licenseType, licenseType));
  return overageOf(licenseType, pool?.quota ?? 0, count);
}

/**
 * AC-PRM-09 的唯一判断点（DEC-143）：余额为 0 或该类许可尚未发放时仍允许授予，余额记为负数，
 * 返回可机读的超额提示，由平台运营补发许可。
 */
function overageOf(licenseType: string, quota: number, used: number): LicenseOverage | null {
  const balance = quota - used;
  return balance < 0 ? { code: 'LICENSE_OVERAGE', licenseType, quota, used, balance } : null;
}

/**
 * DEC-141：撤销授权后，该用户不再持有消耗同类许可的有效授权即归还名额（余额 = 发放总数 − 仍在用的名额）；
 * 仍持有时名额不释放，占用改记到仍有效的那条授权上（使用明细不指向已撤销的授权）。须在授权已置为撤销后调用。
 * @returns 本次是否归还了名额
 */
export async function releaseSeat(
  tx: Tx,
  request: { readonly tenantId: string; readonly licenseType: string; readonly userId: string },
): Promise<boolean> {
  const { tenantId, licenseType, userId } = request;
  await lockLicenseType(tx, tenantId, licenseType);
  const seatOf = and(eq(licenseSeats.licenseType, licenseType), eq(licenseSeats.userId, userId));
  const [seat] = await tx.select().from(licenseSeats).where(seatOf);
  if (!seat) return false;
  const [remaining] = await tx
    .select({ id: permissionGrants.id })
    .from(permissionGrants)
    .innerJoin(
      permissionProfiles,
      and(
        eq(permissionProfiles.tenantId, permissionGrants.tenantId),
        eq(permissionProfiles.id, permissionGrants.profileId),
      ),
    )
    .where(
      and(
        eq(permissionGrants.userId, userId),
        eq(permissionGrants.status, 'active'),
        eq(permissionProfiles.licenseType, licenseType),
        ne(permissionGrants.id, seat.grantId),
      ),
    )
    .orderBy(asc(permissionGrants.createdAt), asc(permissionGrants.id))
    .limit(1);
  const [stillHeld] = remaining
    ? [remaining]
    : await tx
        .select({ id: permissionGrants.id })
        .from(permissionGrants)
        .where(and(eq(permissionGrants.id, seat.grantId), eq(permissionGrants.status, 'active')));
  if (stillHeld) {
    if (stillHeld.id !== seat.grantId) await tx.update(licenseSeats).set({ grantId: stillHeld.id }).where(seatOf);
    return false;
  }
  await tx.delete(licenseSeats).where(seatOf);
  return true;
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
  if (!(await licenseTypeKnown(tx, licenseType))) throw new AppError('NOT_FOUND', '许可类型不存在');
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

/** 已发放，或虽未发放但已有超额占用（DEC-143）。 */
async function licenseTypeKnown(tx: Tx, licenseType: string): Promise<boolean> {
  if (!LICENSE_TYPE.test(licenseType)) return false;
  const [pool] = await tx.select().from(licensePools).where(eq(licensePools.licenseType, licenseType));
  if (pool) return true;
  const [seat] = await tx.select().from(licenseSeats).where(eq(licenseSeats.licenseType, licenseType)).limit(1);
  return seat !== undefined;
}
