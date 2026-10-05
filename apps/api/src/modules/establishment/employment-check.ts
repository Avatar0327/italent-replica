import { insertedWindow, recordWindow } from '../employment/reporting-cycle.js';
import { camelRow, snapshotFields, type EmploymentPayloadRow } from '../employment/record-store.js';
import { resolveEffectiveInheritance } from '../employment/inheritance.js';
import { employmentTimelineNeighbors, operationKey } from '../employment/timeline.js';
/** DEC-145 / 18 §11：真实任职投影，条件内且、条件间或；外部人员计数但不拦其调入。 */
import { auditActor } from '../../system-actor.js';
import { AppError } from '../../errors.js';
import { tenantLocalDate } from '@italent/domain';
import { sql, type Tx } from '@italent/db';
import type { ActivationTarget } from '../employment/activation-checks.js';
import type { EmploymentContext, PresetFields } from '../employment/types.js';
import { findPredecessor, loadEmploymentBusiness, loadEmploymentRecord } from '../employment/read-model.js';
import { loadScheme, type OccupancyRange } from './schemes.js';
import { membershipWindows, clipMembership, type MembershipWindow } from './membership-windows.js';
import { lockEstablishment, rowsOf } from './store.js';
import { targetCapacities } from './transfer-service.js';

export async function employmentEstablishmentExceeded(tx: Tx, ctx: EmploymentContext, target: ActivationTarget) {
  if (target.kind !== 'transfer' || !target.departmentId) return false;
  // 人员锁在调用方已获取；编制锁只保护容量/占编读取，不在持编制锁后获取其他员工锁。
  await lockEstablishment(tx, { ...ctx, userId: auditActor(ctx.userId) }, { initializeDefault: false });
  const previous = await findPredecessor(tx, ctx.tenantId, target.employeeId, target.effectiveDate);
  const business = target.fields
    ? null
    : await loadEmploymentBusiness(tx, ctx.tenantId, target.businessId, target.effectiveDate);
  const fields = {
    ...previous?.fields,
    ...(target.fields ?? business?.fields),
    departmentId: target.departmentId,
    positionId: target.positionId,
    employType: target.fields?.employType ?? previous?.fields.employType ?? 'internal',
  };
  if (fields.employType === 'external') return false;
  const transfer = {
    ...target,
    targetOrgId: target.departmentId,
    sourceOrgId: previous?.fields.departmentId ?? target.departmentId,
  };
  // 周期仍取原调动日；重试允许采用 HR 当天已生效的容量调整，不强迫回溯修改历史编制。
  const capacityAsOf = [target.effectiveDate, tenantLocalDate(ctx.now, ctx.timezone)].sort().at(-1)!;
  for (const capacity of await targetCapacities(tx, ctx, transfer, capacityAsOf)) {
    const scheme = await loadScheme(tx, ctx.tenantId, capacity.schemeId, capacityAsOf);
    if (!matchesOccupancy(fields, scheme.occupancyRanges)) continue;
    const windows = await membershipWindows(
      tx,
      ctx.tenantId,
      capacity.orgId,
      target.effectiveDate,
      capacity.periodEnd,
      scheme.excludedOrgIds,
    );
    const ids = [...new Set(windows.flatMap((window) => window.orgIds))];
    const members = await projectedMembers(
      tx,
      ctx,
      { ...target, fields },
      capacity.periodStart,
      capacity.periodEnd,
      ids,
      windows,
    );
    const count = (inclusive: boolean, positionId?: string) =>
      members(
        (person) =>
          (inclusive ? ids.includes(String(person.departmentId)) : person.departmentId === capacity.orgId) &&
          (!positionId || person.positionId === positionId) &&
          matchesOccupancy(person, scheme.occupancyRanges),
      );
    const exceeds = (local: number | null, inclusive: number | null, positionId?: string) =>
      (capacity.orgId === target.departmentId && local !== null && count(false, positionId) > local) ||
      (inclusive !== null && count(true, positionId) > inclusive);
    if (capacity.strictControl && exceeds(capacity.localCapacity, capacity.inclusiveCapacity)) return true;
    if (scheme.subdivision === 'position') {
      const part = capacity.subdivisions.find((item) => item.positionId === target.positionId);
      if (!part && scheme.unmatchedPolicy === 'reject') return true;
      if (part && capacity.strictControl && exceeds(part.localCapacity, part.inclusiveCapacity, part.positionId))
        return true;
    }
  }
  return false;
}

export function matchesOccupancy(fields: Partial<PresetFields>, ranges: readonly OccupancyRange[]): boolean {
  return (
    !ranges.length ||
    ranges.some(
      (range) =>
        range.employmentType === fields.employType &&
        Object.entries(range.conditions ?? {}).every(([field, values]) =>
          values.includes(String(fields[field as keyof PresetFields] ?? '')),
        ),
    )
  );
}

interface MemberInterval {
  readonly employeeId: string;
  readonly fields: Partial<PresetFields>;
  readonly from: string;
  readonly until: string;
}

async function projectedMembers(
  tx: Tx,
  ctx: EmploymentContext,
  target: ActivationTarget,
  start: string,
  end: string,
  orgIds: readonly string[],
  windows: readonly MembershipWindow[],
) {
  // P2-1：读取目标日到周期末的真实主职区间，在变化点取人数峰值。
  // SQL 先按目标子树裁剪；时间轴区间天然包含直接调入、调出、入职、离职等已落地业务。
  // 本次按实际区间并入同一端点扫描，不能把本人当成永久占编的常量。
  const rows = await occupancyRows(tx, ctx, target, end, orgIds);
  // 申请单只在指定占用/释放时机后参与；撤回/驳回自动退出，已落地单不重复统计。
  const pending = await pendingTransfers(tx, ctx, target, start, end);
  const { readSettings } = await import('./settings.js');
  const timings = await readSettings(tx, ctx.tenantId, target.effectiveDate);
  const periodUntil = new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10);
  const members = new Map<string, MemberInterval[]>();
  for (const row of rows) {
    const intervals = members.get(row.employeeId) ?? [];
    intervals.push({ employeeId: row.employeeId, fields: camelFields(row.fields), from: row.from, until: row.until });
    members.set(row.employeeId, intervals);
  }
  // DEC-108：同日按最近提交的实际操作序号投影，不能按 UUID 排序。
  const projectedPredecessors = new Map<string, Awaited<ReturnType<typeof findPredecessor>>>();
  for (const row of pending) {
    const raw = camelRow(row.fields);
    const payload = { ...raw, fields: snapshotFields(raw) } as unknown as EmploymentPayloadRow;
    const window = await insertedWindow(tx, ctx, row.employeeId, payload.effectiveDate, payload.businessId);
    if (!window) continue;
    const { previous: point } = await employmentTimelineNeighbors(
      tx,
      ctx,
      row.employeeId,
      payload.effectiveDate,
      payload.businessId,
    );
    const original = point ? await loadEmploymentRecord(tx, ctx.tenantId, point.recordId, payload.effectiveDate) : null;
    const projected = projectedPredecessors.get(row.employeeId);
    const predecessor =
      projected && (!original || projected.effectiveDate >= original.effectiveDate) ? projected : original;
    const resolved = await resolveEffectiveInheritance(tx, ctx, payload, {
      staffId: payload.selectedStaffId ?? predecessor?.staffId ?? '',
      predecessor,
    });
    const fields = { ...resolved.fields, employType: predecessor?.fields.employType ?? 'internal' };
    if (predecessor)
      projectedPredecessors.set(row.employeeId, {
        ...predecessor,
        id: payload.businessId,
        fields,
        effectiveDate: payload.effectiveDate,
      });
    const from = [payload.effectiveDate, target.effectiveDate].sort().at(-1)!;
    const until = window?.to && window.to < periodUntil ? window.to : periodUntil;
    if (!window || from >= until) continue;
    const previous = members.get(row.employeeId) ?? [];
    const intervals =
      timings.transferOut === 'submitted' || row.state === 'approved'
        ? previous.flatMap((interval) => {
            if (interval.until <= from || interval.from >= until) return [interval];
            return [
              ...(interval.from < from ? [{ ...interval, until: from }] : []),
              ...(interval.until > until ? [{ ...interval, from: until }] : []),
            ];
          })
        : previous;
    if (timings.transferIn === 'submitted' || row.state === 'approved')
      intervals.push({ employeeId: row.employeeId, fields, from, until });
    members.set(row.employeeId, intervals);
  }
  await projectTarget(tx, ctx, target, periodUntil, members);
  for (const [id, intervals] of members) members.set(id, clipMembership(intervals, windows));
  return (matches: (fields: Partial<PresetFields>) => boolean) => maximumMembers(members, matches);
}

/** 扫描合并区间的端点，O(n log n)，无需逐日或逐变化点重新遍历全员。 */
function maximumMembers(
  members: ReadonlyMap<string, readonly MemberInterval[]>,
  matches: (fields: Partial<PresetFields>) => boolean,
) {
  const changes = new Map<string, number>();
  const add = (date: string, delta: number) => changes.set(date, (changes.get(date) ?? 0) + delta);
  for (const intervals of members.values()) {
    // 先合并同一员工匹配条件的区间（含尚未释放原任职时的预占），再计数。
    const ranges = intervals.filter((i) => matches(i.fields)).sort((a, b) => a.from.localeCompare(b.from));
    let merged: { from: string; until: string } | undefined;
    for (const range of ranges) {
      if (merged && range.from <= merged.until) {
        if (range.until > merged.until) merged.until = range.until;
      } else {
        if (merged) {
          add(merged.from, 1);
          add(merged.until, -1);
        }
        merged = { from: range.from, until: range.until };
      }
    }
    if (merged) {
      add(merged.from, 1);
      add(merged.until, -1);
    }
  }
  let count = 0;
  let maximum = 0;
  for (const [, delta] of [...changes].sort(([a], [b]) => a.localeCompare(b))) {
    count += delta;
    maximum = Math.max(maximum, count);
  }
  return maximum;
}
function camelFields(fields: Record<string, unknown>): Partial<PresetFields> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}

async function occupancyRows(
  tx: Tx,
  ctx: EmploymentContext,
  target: ActivationTarget,
  end: string,
  orgIds: readonly string[],
) {
  const rows = rowsOf<{ employeeId: string; fields: Record<string, unknown>; from: string; until: string }>(
    await tx.execute(sql`
    SELECT r.employee_id AS "employeeId", COALESCE(p.body,to_jsonb(r)) AS fields,
      GREATEST(lower(t.valid_during),${target.effectiveDate}::date)::text AS "from",
      LEAST(upper(t.valid_during),${end}::date+1)::text AS until
    FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    LEFT JOIN LATERAL (SELECT to_jsonb(p) AS body FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1) p ON true
    WHERE t.tenant_id=${ctx.tenantId} AND t.valid_during && daterange(${target.effectiveDate}::date,${end}::date+1,'[)')
      AND (COALESCE(p.body,to_jsonb(r))->>'department_id')::uuid = ANY(${`{${orgIds.join(',')}}`}::uuid[])
      AND r.service_type='primary' AND r.kind NOT IN ('leave','retirement')
      AND r.employee_id<>${target.employeeId}::uuid
    ORDER BY r.employee_id LIMIT 100001
  `),
  );
  if (rows.length > 100000) throw new AppError('SERVICE_UNAVAILABLE', '编制实有人员超过处理上限');
  return rows;
}

async function pendingTransfers(tx: Tx, ctx: EmploymentContext, target: ActivationTarget, start: string, end: string) {
  const pending = rowsOf<{ employeeId: string; fields: Record<string, unknown>; state: string }>(
    await tx.execute(sql`
    SELECT b.employee_id AS "employeeId",
      to_jsonb(p) || jsonb_build_object('employ_type',COALESCE(current_record.employ_type,'internal')) AS fields,s.state
    FROM employment_business_objects b
    JOIN LATERAL (SELECT * FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id
      ORDER BY version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id
      ORDER BY event_no DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT r.employ_type FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      WHERE t.tenant_id=b.tenant_id AND t.employee_id=b.employee_id
        AND t.valid_during @> p.effective_date AND r.service_type='primary' LIMIT 1) current_record ON true
    WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id<>${target.employeeId}::uuid
      AND p.kind='transfer' AND p.mode='application' AND s.state IN ('in_review','approved')
      AND p.effective_date BETWEEN ${start}::date AND ${end}::date
    ORDER BY p.effective_date,${operationKey(ctx.tenantId, sql`b.id`)} LIMIT 10001
  `),
  );
  if (pending.length > 10000) throw new AppError('SERVICE_UNAVAILABLE', '编制占用申请超过处理上限');
  return pending;
}

async function projectTarget(
  tx: Tx,
  ctx: EmploymentContext,
  target: ActivationTarget,
  periodUntil: string,
  members: Map<string, MemberInterval[]>,
) {
  const [existing] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM employment_timeline
    WHERE tenant_id=${ctx.tenantId} AND record_id=${target.businessId}::uuid`),
  );
  const window = existing
    ? await recordWindow(tx, ctx.tenantId, target.businessId)
    : await insertedWindow(tx, ctx, target.employeeId, target.effectiveDate, target.businessId);
  if (window) {
    const from = [window.from, target.effectiveDate].sort().at(-1)!;
    const until = window.to && window.to < periodUntil ? window.to : periodUntil;
    if (from < until)
      members.set(target.employeeId, [
        {
          employeeId: target.employeeId,
          fields: target.fields ?? {},
          from,
          until,
        },
      ]);
  }
}
