import {
  and,
  asc,
  desc,
  eq,
  establishmentObjects,
  establishmentSchemeVersions,
  gte,
  lte,
  orgVersions,
  sql,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';

export interface CapacityPeriod {
  readonly orgId: string;
  readonly schemeId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}

export interface CapacityOverlap {
  readonly schemeId: string;
  /** 冲突区间的首月（新周期与已有周期交集的起始月，1～12）。 */
  readonly month: number;
  readonly sameKey: boolean;
}

/**
 * 同一组织（租户内）任一方案的编制与新周期按月份区间重叠即冲突（DEC-279① / DEC-295①，F-037 / F-484）。
 * 已停用方案留下的历史编制仍是组织在该月的编制，照样参与判定（停用本身只在没有当前 / 未来周期编制时才被允许）。
 * 调用方须已持编制租户锁（lockEstablishment）：写入串行，检查之后到插入之前不会有同租户的并发写入插进来。
 */
export async function findCapacityOverlap(tx: Tx, tenantId: string, period: CapacityPeriod) {
  const sameStart = sql`${establishmentObjects.periodStart} = ${period.periodStart}`;
  const [row] = await tx
    .select({
      schemeId: establishmentObjects.schemeId,
      periodStart: establishmentObjects.periodStart,
    })
    .from(establishmentObjects)
    .where(
      and(
        eq(establishmentObjects.tenantId, tenantId),
        eq(establishmentObjects.orgId, period.orgId),
        lte(establishmentObjects.periodStart, period.periodEnd),
        gte(establishmentObjects.periodEnd, period.periodStart),
      ),
    )
    // 与新建键完全相同的行优先，保持既有 CAPACITY_EXISTS 原因码；其余取最早重叠的一条，结果与录入顺序无关
    .orderBy(
      desc(sql`(${establishmentObjects.schemeId} = ${period.schemeId} AND ${sameStart})`),
      asc(establishmentObjects.periodStart),
      asc(establishmentObjects.schemeId),
    )
    .limit(1);
  if (!row) return null;
  const start = row.periodStart > period.periodStart ? row.periodStart : period.periodStart;
  return {
    schemeId: row.schemeId,
    month: Number(start.slice(5, 7)),
    sameKey: row.schemeId === period.schemeId && row.periodStart === period.periodStart,
  } satisfies CapacityOverlap;
}

/** 拒绝文案照北森原文：“{组织}已设有{M}月编制，编制方案为{方案}，不可新建，请检查”（DEC-295①）。 */
export async function assertNoCapacityOverlap(tx: Tx, tenantId: string, period: CapacityPeriod, asOf: string) {
  const overlap = await findCapacityOverlap(tx, tenantId, period);
  if (!overlap) return;
  const [org] = await tx
    .select({ name: orgVersions.name })
    .from(orgVersions)
    .where(
      and(eq(orgVersions.tenantId, tenantId), eq(orgVersions.orgId, period.orgId), lte(orgVersions.startDate, asOf)),
    )
    .orderBy(desc(orgVersions.startDate), desc(orgVersions.versionNo))
    .limit(1);
  const [scheme] = await tx
    .select({ name: establishmentSchemeVersions.name })
    .from(establishmentSchemeVersions)
    .where(
      and(
        eq(establishmentSchemeVersions.tenantId, tenantId),
        eq(establishmentSchemeVersions.schemeId, overlap.schemeId),
      ),
    )
    .orderBy(desc(establishmentSchemeVersions.versionNo))
    .limit(1);
  throw new AppError(
    'CONFLICT',
    `${org?.name ?? ''}已设有${overlap.month}月编制，编制方案为${scheme?.name ?? ''}，不可新建，请检查`,
    { reason: overlap.sameKey ? 'CAPACITY_EXISTS' : 'CAPACITY_PERIOD_OVERLAP' },
  );
}
