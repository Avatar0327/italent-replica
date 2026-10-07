import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { assertEstablishmentCapacity, type ActivationTarget } from '../employment/activation-checks.js';
import type { LockedEmploymentBusiness } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import { assessmentDates } from './assessment-windows.js';
import { matchesOccupancy, projectedIntervals, type MemberInterval } from './employment-check.js';
import { loadScheme } from './schemes.js';
import { lockEstablishment, rowsOf } from './store.js';
import { targetCapacities } from './transfer-service.js';

interface Segment {
  readonly from: string;
  readonly until: string;
  readonly before: readonly MemberInterval[];
}
const adjacentDay = (date: string, offset: number) =>
  new Date(Date.parse(date) + offset * 86400000).toISOString().slice(0, 10);

/** 普通申请撤回/作废/驳回/删除也会恢复预减；先冻结本人的真实投影，避免误拦只释放调入的动作。 */
export async function captureReservedOccupancy(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness) {
  if (business.payload.kind !== 'transfer' || !['in_review', 'approved'].includes(business.state)) return [];
  await lockEstablishment(tx, ctx, { initializeDefault: false });
  const from = [business.payload.effectiveDate, tenantLocalDate(ctx.now, ctx.timezone)].sort().at(-1)!;
  const [period] = rowsOf<{ end: string | null }>(
    await tx.execute(sql`SELECT max(period_end)::text AS end FROM establishment_objects
      WHERE tenant_id=${ctx.tenantId} AND period_end>=${from}::date`),
  );
  if (!period?.end) return [];
  const until = adjacentDay(period.end, 1);
  const dates = await assessmentDates(tx, ctx.tenantId, from, until);
  const segments: Segment[] = [];
  for (const [index, date] of dates.entries()) {
    const end = dates[index + 1] ?? until;
    segments.push({ from: date, until: end, before: await employeeIntervals(tx, ctx, business, date, end) });
  }
  return segments;
}

export async function assertRestoredReservation(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  segments: readonly Segment[],
) {
  for (const segment of segments) {
    const after = await employeeIntervals(tx, ctx, business, segment.from, segment.until);
    for (const interval of after) {
      const departmentId = interval.fields.departmentId;
      if (!departmentId) continue;
      const target = { targetOrgId: departmentId, effectiveDate: interval.from };
      const capacityAsOf = [interval.from, tenantLocalDate(ctx.now, ctx.timezone)].sort().at(-1)!;
      const capacities = await targetCapacities(tx, ctx, target, capacityAsOf);
      const schemes = await Promise.all(capacities.map((c) => loadScheme(tx, ctx.tenantId, c.schemeId, capacityAsOf)));
      if (!schemes.some((scheme) => matchesOccupancy(interval.fields, scheme.occupancyRanges))) continue;
      // 同人可能有多个在途段；按覆盖区间相减，不能只找当前任职或第一笔申请。
      const covered = segment.before.filter(
        (previous) =>
          previous.fields.departmentId === departmentId &&
          previous.fields.positionId === interval.fields.positionId &&
          schemes.every(
            (scheme) =>
              !matchesOccupancy(interval.fields, scheme.occupancyRanges) ||
              matchesOccupancy(previous.fields, scheme.occupancyRanges),
          ),
      );
      for (const gap of uncovered(interval, covered))
        await assertEstablishmentCapacity(tx, ctx, {
          businessId: business.id,
          employeeId: business.employeeId,
          kind: 'transfer',
          effectiveDate: gap.from,
          until: gap.until,
          departmentId,
          positionId: interval.fields.positionId ?? null,
          fields: interval.fields,
          occupancyOnly: true,
        });
    }
  }
}

async function employeeIntervals(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  from: string,
  until: string,
) {
  // 使用不存在的 ID，使共用投影包含本单；状态事件前后分别读取即可得到预减恢复的差集。
  const target: ActivationTarget = {
    businessId: '00000000-0000-0000-0000-000000000000',
    employeeId: business.employeeId,
    kind: 'transfer',
    effectiveDate: from,
    until,
    departmentId: null,
    positionId: null,
    occupancyOnly: true,
  };
  const members = await projectedIntervals(tx, ctx, target, adjacentDay(until, -1), null, business.employeeId);
  return members.get(business.employeeId) ?? [];
}

function uncovered(interval: MemberInterval, covered: readonly MemberInterval[]) {
  let ranges = [{ from: interval.from, until: interval.until }];
  for (const before of covered)
    ranges = ranges.flatMap((range) => {
      if (before.until <= range.from || before.from >= range.until) return [range];
      return [
        ...(range.from < before.from ? [{ from: range.from, until: before.from }] : []),
        ...(before.until < range.until ? [{ from: before.until, until: range.until }] : []),
      ];
    });
  return ranges;
}
