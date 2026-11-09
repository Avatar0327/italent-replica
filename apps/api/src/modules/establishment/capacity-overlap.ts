import {
  and,
  asc,
  desc,
  eq,
  establishmentObjects,
  type EstablishmentCapacityConflict,
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

/** 无权看方案名称时的提示：不带任何方案信息，沿用旧实现同键重复的通用冲突文案（同键）或同义的重叠文案。 */
const GENERIC_EXISTS = '该组织、方案和周期已有编制';
const GENERIC_OVERLAP = '该组织在重叠期间已有编制，不可新建，请检查';

export const genericOverlapMessage = (reason: EstablishmentCapacityConflict['reason']) =>
  reason === 'CAPACITY_EXISTS' ? GENERIC_EXISTS : GENERIC_OVERLAP;

/**
 * 重叠拒绝：对外 details 仍只有原因码；结构化冲突信息（组织 / 方案 ID、月份）放在 conflict 上，
 * 只供复制任务持久化后在读取时按读取人权限重新生成文案，不进入 HTTP 响应（F-484 第 2 轮）。
 */
export class CapacityOverlapError extends AppError {
  constructor(
    message: string,
    readonly conflict: EstablishmentCapacityConflict,
  ) {
    super('CONFLICT', message, { reason: conflict.reason });
  }
}

/**
 * 拒绝文案照北森原文：“{组织}已设有{M}月编制，编制方案为{方案}，不可新建，请检查”（DEC-295①）。
 * 只有读取人对该方案有详情查看范围且可读名称字段（disclose）时才披露方案名与组织名（DEC-121）；
 * 否则整句不带任何名称。
 */
export async function overlapMessage(
  tx: Tx,
  tenantId: string,
  conflict: EstablishmentCapacityConflict,
  disclose: boolean,
): Promise<string> {
  if (!disclose) return genericOverlapMessage(conflict.reason);
  const [org] = await tx
    .select({ name: orgVersions.name })
    .from(orgVersions)
    .where(
      and(
        eq(orgVersions.tenantId, tenantId),
        eq(orgVersions.orgId, conflict.orgId),
        lte(orgVersions.startDate, conflict.asOf),
      ),
    )
    .orderBy(desc(orgVersions.startDate), desc(orgVersions.versionNo))
    .limit(1);
  const [scheme] = await tx
    .select({ name: establishmentSchemeVersions.name })
    .from(establishmentSchemeVersions)
    .where(
      and(
        eq(establishmentSchemeVersions.tenantId, tenantId),
        eq(establishmentSchemeVersions.schemeId, conflict.schemeId),
      ),
    )
    .orderBy(desc(establishmentSchemeVersions.versionNo))
    .limit(1);
  return `${org?.name ?? ''}已设有${conflict.month}月编制，编制方案为${scheme?.name ?? ''}，不可新建，请检查`;
}

/** 重叠检查全量执行；提示按操作人当前权限生成（canDiscloseSchemeName 未注入 = 可信端口，不披露）。 */
export async function assertNoCapacityOverlap(
  tx: Tx,
  tenantId: string,
  period: CapacityPeriod,
  asOf: string,
  canDiscloseSchemeName?: (schemeId: string) => Promise<boolean>,
) {
  const overlap = await findCapacityOverlap(tx, tenantId, period);
  if (!overlap) return;
  const conflict: EstablishmentCapacityConflict = {
    reason: overlap.sameKey ? 'CAPACITY_EXISTS' : 'CAPACITY_PERIOD_OVERLAP',
    orgId: period.orgId,
    schemeId: overlap.schemeId,
    month: overlap.month,
    asOf,
  };
  const disclose = (await canDiscloseSchemeName?.(overlap.schemeId)) ?? false;
  throw new CapacityOverlapError(await overlapMessage(tx, tenantId, conflict, disclose), conflict);
}
