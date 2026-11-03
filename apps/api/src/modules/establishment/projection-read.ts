/** DEC-791①：按有效业务笔数读取预增 / 预减；来源不能在员工区间归并时丢失。 */
import { sql, type Tx } from '@italent/db';
import { addDays, exitOccupancy, newlyOccupied, type ExitState } from '@italent/domain';
import { AppError } from '../../errors.js';
import { employmentCreator } from '../employment/context.js';
import { loadExitStates, cycleOn } from '../employment/exit-occupancy-store.js';
import { projectOrgAdjustmentRecords } from '../employment/org-adjustment-projection.js';
import { findCurrentRecord, loadEmploymentRecord } from '../employment/read-model.js';
import { camelRow, snapshotFields, type EmploymentPayloadRow } from '../employment/record-store.js';
import { insertedWindow, recordWindow } from '../employment/reporting-cycle.js';
import { employmentVisibilitySql } from '../employment/visibility.js';
import type { EmploymentContext, EmploymentRecord, PresetFields } from '../employment/types.js';
import type { CapacityRecord } from './capacity-read.js';
import { countsTransfer, matchesOccupancy, pendingTransfers, resolveProjectedTransfer } from './employment-check.js';
import { clipMembership, membershipWindows } from './membership-windows.js';
import { loadSchemeBatch } from './schemes.js';
import { readSettings } from './settings.js';
import { projectionEmployeeScope } from './projection-scope.js';
import { rowsOf } from './store.js';

export interface ProjectionContribution {
  readonly businessId: string;
  readonly employeeId: string;
  readonly kind: string;
  readonly direction: 'in' | 'out';
  readonly effectiveDate: string;
  /** 同一来源可能被组织窗口切成多段，但每方向只计一笔。半开区间。 */
  readonly segments: readonly { departmentId: string; from: string; until: string }[];
}
export interface OrganizationProjection {
  readonly capacityId: string;
  readonly orgId: string;
  readonly pendingIn: number;
  readonly pendingOut: number;
  readonly contributions: readonly ProjectionContribution[];
}
interface Source extends Omit<ProjectionContribution, 'segments'> {
  readonly fields: Partial<PresetFields>;
  readonly counterpart?: Partial<PresetFields> | null;
  readonly staffId: string;
  readonly throughRecordId?: string;
  readonly from: string;
  readonly until: string;
}

/** 内部读接口：调用方必须提供取数日已授权的员工集合及范围；内部继承读取只能服务于这些员工。 */
export async function readOrganizationProjections(
  tx: Tx,
  ctx: EmploymentContext & { readonly scope: NonNullable<EmploymentContext['scope']> },
  day: string,
  capacities: readonly CapacityRecord[],
  employmentTypes: readonly string[],
  visibleEmployeeIds: readonly string[],
): Promise<OrganizationProjection[]> {
  if (!capacities.length) return [];
  const end = capacities.reduce((latest, c) => (c.periodEnd > latest ? c.periodEnd : latest), day);
  // day 已经是调用方解析好的租户业务日；继承 / 时机推演用该日，不能受服务器或浏览器时区影响。
  const at = { ...ctx, now: new Date(`${day}T12:00:00Z`), timezone: 'UTC' };
  const sources = await visibleSources(tx, ctx, await projectionSources(tx, at, day, end, visibleEmployeeIds));
  const schemes = new Map(
    (await loadSchemeBatch(tx, ctx.tenantId, [...new Set(capacities.map((c) => c.schemeId))], day)).map((s) => [
      s.id,
      s,
    ]),
  );
  const windows = new Map<string, Awaited<ReturnType<typeof membershipWindows>>>();
  const result: OrganizationProjection[] = [];
  for (const capacity of capacities) {
    const scheme = schemes.get(capacity.schemeId)!;
    const candidates = sources.filter(
      (s) =>
        employmentTypes.includes(s.fields.employType ?? '') &&
        s.effectiveDate >= capacity.periodStart &&
        s.effectiveDate <= capacity.periodEnd &&
        matchesOccupancy(s.fields, scheme.occupancyRanges) &&
        !(
          s.counterpart &&
          s.counterpart.departmentId === s.fields.departmentId &&
          employmentTypes.includes(s.counterpart?.employType ?? '') &&
          matchesOccupancy(s.counterpart, scheme.occupancyRanges)
        ),
    );
    const contributions = new Map<string, ProjectionContribution>();
    if (candidates.length) {
      const windowKey = JSON.stringify([capacity.orgId, capacity.periodEnd, scheme.excludedOrgIds]);
      if (!windows.has(windowKey)) {
        const parts = await membershipWindows(
          tx,
          ctx.tenantId,
          capacity.orgId,
          day,
          capacity.periodEnd,
          scheme.excludedOrgIds,
        );
        // 最后半开端点只用于内存比较，不能把 10000 年截成无效 ISO 日期。
        if (parts.length) parts[parts.length - 1] = { ...parts.at(-1)!, until: projectionUntil(capacity.periodEnd) };
        windows.set(windowKey, parts);
      }
      for (const source of candidates) {
        const parts = clipMembership([source], windows.get(windowKey)!);
        if (!parts.length) continue;
        const key = `${source.businessId}:${source.direction}`;
        const previous = contributions.get(key);
        contributions.set(key, {
          businessId: source.businessId,
          employeeId: source.employeeId,
          kind: source.kind,
          direction: source.direction,
          effectiveDate: source.effectiveDate,
          segments: [
            ...(previous?.segments ?? []),
            ...parts.map(({ fields, from, until }) => ({ departmentId: String(fields.departmentId), from, until })),
          ],
        });
      }
    }
    const values = [...contributions.values()];
    result.push({
      capacityId: capacity.id,
      orgId: capacity.orgId,
      contributions: values,
      pendingIn: values.filter((s) => s.direction === 'in').length,
      pendingOut: values.filter((s) => s.direction === 'out').length,
    });
  }
  return result;
}

/** 与报表 employmentVisible 相同的 DEC-177 谓词及创建人回退；按贡献所属部门分别裁剪。 */
async function visibleSources(tx: Tx, ctx: EmploymentContext, sources: readonly Source[]) {
  if (!sources.length) return [];
  const rows = rowsOf<{ index: number }>(
    await tx.execute(sql`
    SELECT m.index FROM jsonb_to_recordset(${JSON.stringify(
      sources.map((s, index) => ({
        index,
        employee_id: s.employeeId,
        org_id: s.fields.departmentId ?? null,
      })),
    )}::jsonb) AS m(index int, employee_id uuid, org_id uuid)
    JOIN employment_employees e ON e.tenant_id=${ctx.tenantId} AND e.id=m.employee_id
    WHERE ${employmentVisibilitySql(ctx.scope, {
      employee: sql`m.employee_id`,
      department: sql`m.org_id`,
      creator: employmentCreator(ctx.tenantId, sql`m.employee_id`),
    })}`),
  );
  const visible = new Set(rows.map((r) => Number(r.index)));
  return sources.filter((_, index) => visible.has(index));
}

async function projectionSources(
  tx: Tx,
  ctx: EmploymentContext,
  day: string,
  end: string,
  visibleEmployeeIds: readonly string[],
): Promise<Source[]> {
  const timings = await readSettings(tx, ctx.tenantId, day);
  const until = projectionUntil(end);
  const sources: Source[] = [];
  const predecessors = new Map<string, EmploymentRecord | null>();
  const adjustments = new Map<string, EmploymentRecord>();
  for (const row of await pendingTransfers(tx, ctx, {}, day, end, true, visibleEmployeeIds)) {
    const raw = camelRow(row.fields);
    const payload = { ...raw, fields: snapshotFields(raw) } as unknown as EmploymentPayloadRow;
    const recorded =
      row.state === 'effective'
        ? await loadEmploymentRecord(tx, ctx.tenantId, payload.businessId, payload.effectiveDate)
        : null;
    const window = recorded
      ? await recordWindow(tx, ctx.tenantId, payload.businessId)
      : await insertedWindow(tx, ctx, row.employeeId, payload.effectiveDate, payload.businessId);
    const { predecessor, resolved, fields } = await resolveProjectedTransfer(
      tx,
      ctx,
      payload,
      row.state,
      predecessors,
      adjustments,
      recorded,
    );
    if (predecessor)
      predecessors.set(row.employeeId, {
        ...predecessor,
        id: payload.businessId,
        fields,
        effectiveDate: payload.effectiveDate,
      });
    const staffId =
      payload.selectedStaffId ??
      (await cycleOn(tx, ctx.tenantId, row.employeeId, String(raw.declaredEffectiveDate ?? payload.effectiveDate))) ??
      predecessor?.staffId ??
      payload.businessId;
    const common = {
      businessId: payload.businessId,
      employeeId: row.employeeId,
      kind: payload.kind,
      effectiveDate: payload.effectiveDate,
      staffId,
      from: payload.effectiveDate,
      until: window?.to && window.to < until ? window.to : until,
    };
    if (!window || common.from >= common.until) continue;
    const incoming = countsTransfer(row.state, timings.transferIn);
    const outgoing = countsTransfer(row.state, timings.transferOut);
    // 与累计投影相同：后序调出截断前序申请的窗口；不同业务的已存在区间仍各自保留来源。
    if (outgoing) truncateSources(sources, row.employeeId, payload.businessId, common.from);
    const before = payload.formSnapshot.startsNewCycle ? null : (predecessor?.fields ?? null);
    // 同组织的任职字段变更只在占编条件改变时产生贡献，由方案匹配阶段再判。
    if (before && outgoing) sources.push({ ...common, fields: before, counterpart: fields, direction: 'out' });
    if (incoming) sources.push({ ...common, fields, counterpart: before, direction: 'in' });
    if (predecessor && incoming) {
      for (const record of await projectOrgAdjustmentRecords(
        tx,
        ctx,
        {
          ...payload,
          before: predecessor,
          after: { fields, customFields: resolved.customFields },
        },
        adjustments,
      )) {
        const from = record.effectiveDate > day ? record.effectiveDate : day;
        const to = record.stopDate < end ? addDays(record.stopDate, 1) : until;
        if (from < to) {
          const original = await loadEmploymentRecord(tx, ctx.tenantId, record.id, day);
          const segment = { ...common, from, until: to, throughRecordId: record.id };
          sources.push({ ...segment, fields: record.fields, counterpart: original?.fields ?? null, direction: 'in' });
          if (original && outgoing)
            sources.push({ ...segment, fields: original.fields, counterpart: record.fields, direction: 'out' });
        }
      }
    }
  }
  return applyExitSources(tx, ctx, day, end, sources, timings, visibleEmployeeIds);
}

async function applyExitSources(
  tx: Tx,
  ctx: EmploymentContext,
  day: string,
  end: string,
  sources: Source[],
  timings: Awaited<ReturnType<typeof readSettings>>,
  visibleEmployeeIds: readonly string[],
) {
  const until = projectionUntil(end);
  const exitEmployees = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT DISTINCT x.employee_id AS id FROM exit_requests x
    JOIN LATERAL (SELECT p.effective_date FROM employment_payload_versions p
      WHERE p.tenant_id=x.tenant_id AND p.business_id=x.business_id ORDER BY version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT s.state FROM employment_state_events s
      WHERE s.tenant_id=x.tenant_id AND s.business_id=x.business_id ORDER BY event_no DESC LIMIT 1) s ON true
    WHERE x.tenant_id=${ctx.tenantId} AND p.effective_date>${day}::date AND p.effective_date<=${end}::date
      AND s.state IN ('approved','effective') AND ${projectionEmployeeScope(visibleEmployeeIds, sql`x.employee_id`)} LIMIT 10001`),
  );
  if (exitEmployees.length > 10000) throw new AppError('SERVICE_UNAVAILABLE', '编制离职投影超过处理上限');
  const exits = (
    await loadExitStates(
      tx,
      ctx.tenantId,
      exitEmployees.map((e) => e.id),
    )
  ).filter((e) => e.effectiveDate > day && e.effectiveDate < until);
  // 离职预减复用同周期的释放区间；先移除已释放的调动预占，再以离职单作为预减来源。
  const retained = sources.flatMap((source) => releaseParts(source, exits, timings, false));
  for (const exit of exits) {
    const record = await findCurrentRecord(tx, ctx.tenantId, exit.employeeId, day);
    if (!record || record.staffId !== exit.staffId || record.kind === 'leave' || record.kind === 'retirement') continue;
    const source: Source = {
      businessId: exit.businessId,
      employeeId: exit.employeeId,
      kind: 'exit',
      direction: 'out',
      effectiveDate: exit.effectiveDate,
      fields: record.fields,
      staffId: exit.staffId,
      from: day,
      until,
    };
    retained.push(...releaseParts(source, [exit], timings, true));
  }
  return retained.filter((s) => s.from < s.until);
}

/** 用同一个 exitOccupancy 纯函数取保留段 / 扣减段，不复制释放日期与任职周期判断。 */
function releaseParts(
  source: Source,
  exits: readonly ExitState[],
  timings: Awaited<ReturnType<typeof readSettings>>,
  removed: boolean,
): Source[] {
  const record = {
    recordId: source.businessId,
    employeeId: source.employeeId,
    staffId: source.staffId,
    kind: 'member',
    departmentId: source.fields.departmentId ?? '',
    positionId: null,
    capacityId: null,
    from: source.from,
    to: source.until,
  };
  const input = { records: [record], applications: [], detachedTransfers: [], timings };
  const before = exitOccupancy({ ...input, exits: [] }).p;
  const after = exitOccupancy({ ...input, exits }).p;
  return (removed ? newlyOccupied(after, before) : after).map((part) => ({
    ...source,
    from: part.from,
    until: part.to ?? source.until,
  }));
}

/** 大于所有合法业务日的内存半开端点，不传入数据库。 */
const projectionUntil = (end: string) => (end === '9999-12-31' ? '9999-12-32' : addDays(end, 1));

function truncateSources(sources: Source[], employeeId: string, businessId: string, from: string) {
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]!;
    if (source.employeeId === employeeId && source.until > from && source.throughRecordId !== businessId)
      sources[i] = { ...source, until: from };
  }
}
