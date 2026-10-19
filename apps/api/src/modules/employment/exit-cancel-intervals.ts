/**
 * 撤销离职的区间变化统一校验（R2-T03 设计 §6B.2，DEC-431①）：撤销 approved 离职（§6B.3 表 #1）与撤销已生效离职恢复在职（表 #2）
 * 共用这一个函数，不按入口各写一份公式。做法：撤销前后各读一次占用投影（domain exitOccupancy，与组织停用计数、编制预减读同一实现），
 * 求新增段 ΔO / ΔP 后——
 *   ① ΔO 的每一段调 assertEmploymentDepartmentAvailableWithin：段内任一天组织不可用 → 409 EMPLOYMENT_DEPARTMENT_DISABLED（拒绝，先于确认）；
 *   ② ΔP 的每一段按编制峰值重算（含申请预占段，B-77）：超编 → DEC-258 确认协议 409 CONFIRMATION_REQUIRED（严格控编同样只确认），
 *      请求带 confirmed: true 重提后执行并记审计 employment.exit.over_capacity_confirmed。
 * “撤销后”的投影读的是已执行撤销写入的真实时间轴，所以调用方先做撤销（同一事务），拒绝时整个命令回滚、前后读取相等（§6B.2-5）。
 * 调用方已按全局锁序持有员工 / 业务锁与 ④ 组织设置锁、⑤ 编制锁。
 */
import { sql, type Tx } from '@italent/db';
import {
  exitOccupancy,
  newlyOccupied,
  tenantLocalDate,
  type OccupancySegment,
  type PreOccupancySegment,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import {
  employmentEstablishmentAssessment,
  establishmentPeriodStartsWithin,
} from '../establishment/employment-check.js';
import { readSettings } from '../establishment/settings.js';
import { auditEmployment } from './context.js';
import { disclose } from './exit-gate.js';
import { loadTimelineSegments } from './exit-projection.js';
import { cycleOn, loadExitStates } from './exit-occupancy-store.js';
import { loadEmploymentBusiness, loadEmploymentRecord } from './read-model.js';
import { assertEmploymentDepartmentAvailableWithin } from './references.js';
import { rowsOf } from './record-store.js';
import { insertedWindow } from './reporting-cycle.js';
import { loadPlannedEffectiveDate } from './timeline.js';
import type { EmploymentContext } from './types.js';

export interface OccupancySnapshot {
  readonly o: OccupancySegment[];
  readonly p: OccupancySegment[];
}

/** 员工名下审批中 / 已批准、尚未落地的调动申请的预占段（main projectedMembers 的申请输入；已落地的直接调动已在时间轴记录里）。 */
async function loadApplicationSegments(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  today: string,
): Promise<PreOccupancySegment[]> {
  const rows = rowsOf<{
    id: string;
    state: 'in_review' | 'approved';
    effectiveDate: string;
    selectedStaffId: string | null;
    operationKey: number | null;
  }>(
    await tx.execute(sql`
    SELECT b.id::text AS id, s.state, p.effective_date::text AS "effectiveDate",
      p.selected_staff_id::text AS "selectedStaffId",
      (SELECT COALESCE(max(e.event_seq) FILTER (WHERE e.state = 'in_review'), min(e.event_seq))
        FROM employment_state_events e WHERE e.tenant_id=b.tenant_id AND e.business_id=b.id)::int AS "operationKey"
    FROM employment_business_objects b
    JOIN LATERAL (SELECT * FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id
      ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id
      ORDER BY s.event_no DESC LIMIT 1) s ON true
    WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${employeeId}::uuid AND p.kind='transfer'
      AND p.mode='application' AND s.state IN ('in_review','approved')
      AND NOT EXISTS (SELECT 1 FROM employment_records r WHERE r.tenant_id=b.tenant_id AND r.id=b.id)
    ORDER BY b.id`),
  );
  const segments: PreOccupancySegment[] = [];
  for (const row of rows) {
    const resolved = await loadEmploymentBusiness(tx, ctx.tenantId, row.id, today);
    if (!resolved?.fields.departmentId) continue;
    const window = await insertedWindow(tx, ctx, employeeId, row.effectiveDate, row.id);
    const from = [row.effectiveDate, today].sort().at(-1)!;
    if (!window || (window.to !== null && from >= window.to)) continue;
    segments.push({
      businessId: row.id,
      employeeId,
      staffId: row.selectedStaffId ?? (await cycleOn(tx, ctx.tenantId, employeeId, row.effectiveDate)) ?? '',
      stage: row.state,
      departmentId: resolved.fields.departmentId,
      positionId: resolved.fields.positionId ?? null,
      capacityId: null,
      from,
      to: window.to,
      plannedDate: await loadPlannedEffectiveDate(tx, ctx.tenantId, row.id, row.effectiveDate),
      operationKey: row.operationKey,
    });
  }
  return segments;
}

/** 员工当前的 O / P 投影：时间轴记录 + 申请预占段 + approved / effective 离职；被摘下的调动不在时间轴上即不计，挂回后自然计入。 */
export async function loadOccupancy(tx: Tx, ctx: EmploymentContext, employeeId: string): Promise<OccupancySnapshot> {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const timings = await readSettings(tx, ctx.tenantId, today);
  return exitOccupancy({
    records: await loadTimelineSegments(tx, ctx, employeeId),
    applications: await loadApplicationSegments(tx, ctx, employeeId, today),
    exits: await loadExitStates(tx, ctx.tenantId, [employeeId]),
    detachedTransfers: [],
    timings: { transferIn: timings.transferIn, transferOut: timings.transferOut },
  });
}

interface Warning {
  readonly reason: 'ESTABLISHMENT_EXCEEDED';
  readonly departmentId?: string;
  readonly positionId?: string | null;
  readonly from: string;
  readonly to: string | null;
}

/** 部门在该段起点之后是否对操作人可见（组织名 / 部门 ID 只给可见范围内的人）。 */
async function departmentVisible(tx: Tx, ctx: EmploymentContext, employeeId: string, segment: OccupancySegment) {
  const shown = await disclose(tx, ctx, employeeId, [
    { id: segment.sourceId, effectiveDate: segment.from, departmentId: segment.departmentId },
  ]);
  return shown.items.length > 0;
}

/** ① ΔO：每段有终点校验，不可用 → 409（命令入口）；组织名按可见范围裁剪。 */
async function assertAvailable(tx: Tx, ctx: EmploymentContext, employeeId: string, segments: OccupancySegment[]) {
  for (const segment of segments) {
    try {
      await assertEmploymentDepartmentAvailableWithin(tx, ctx, segment.departmentId, segment.from, segment.to);
    } catch (error) {
      const details = (error as { details?: { reason?: string; disabledOn?: string } }).details;
      if (!(error instanceof AppError) || details?.reason !== 'EMPLOYMENT_DEPARTMENT_DISABLED') throw error;
      const visible = await departmentVisible(tx, ctx, employeeId, segment);
      throw new AppError(
        'CONFLICT',
        visible ? error.message : `任职部门已被停用（停用日期：${details.disabledOn}），请检查`,
        {
          reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
          disabledOn: details.disabledOn,
          ...(visible ? { departmentId: segment.departmentId } : {}),
        },
      );
    }
  }
}

/** ② ΔP 的一段：按来源（时间轴记录 / 申请）取字段，在段起点与段内每个编制周期起点各判一次（同删除恢复前一条的口径）。 */
async function segmentExceeds(tx: Tx, ctx: EmploymentContext, employeeId: string, segment: OccupancySegment) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const fields =
    (await loadEmploymentRecord(tx, ctx.tenantId, segment.sourceId, segment.from))?.fields ??
    (await loadEmploymentBusiness(tx, ctx.tenantId, segment.sourceId, today))?.fields;
  if (!fields) return false;
  const starts = await establishmentPeriodStartsWithin(tx, ctx.tenantId, segment.from, segment.to);
  for (const effectiveDate of [segment.from, ...starts]) {
    const assessment = await employmentEstablishmentAssessment(tx, ctx, {
      businessId: segment.sourceId,
      employeeId,
      kind: 'transfer',
      departmentId: segment.departmentId,
      positionId: segment.positionId,
      effectiveDate,
      until: segment.to,
      reconcileCarried: false,
      fields,
    });
    if (assessment !== 'none') return true;
  }
  return false;
}

async function assertCapacity(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  exitBusinessId: string,
  segments: OccupancySegment[],
  confirmed: boolean,
) {
  const warnings: Warning[] = [];
  let hidden = 0;
  for (const segment of segments) {
    if (!(await segmentExceeds(tx, ctx, employeeId, segment))) continue;
    if (await departmentVisible(tx, ctx, employeeId, segment))
      warnings.push({
        reason: 'ESTABLISHMENT_EXCEEDED',
        departmentId: segment.departmentId,
        positionId: segment.positionId,
        from: segment.from,
        to: segment.to,
      });
    else hidden += 1;
  }
  if (!warnings.length && !hidden) return;
  if (!confirmed)
    throw new AppError('CONFLICT', '撤销离职后将超出设定编制，请确认', {
      reason: 'CONFIRMATION_REQUIRED',
      warnings,
      hiddenCount: hidden,
    });
  await auditEmployment(
    tx,
    ctx,
    'employment.exit.over_capacity_confirmed',
    'exit-request',
    exitBusinessId,
    null,
    { warnings, hiddenCount: hidden },
    undefined,
    undefined,
    { employeeId },
  );
}

/**
 * §6B.2 唯一规则：撤销已执行之后，对比 before（撤销前投影）与现在的投影，ΔO 先拒绝、ΔP 再确认。
 * 任一步拒绝都抛错，调用方事务回滚。
 */
export async function assertOccupancyChange(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  exitBusinessId: string,
  before: OccupancySnapshot,
  confirmed: boolean,
): Promise<void> {
  const after = await loadOccupancy(tx, ctx, employeeId);
  await assertAvailable(tx, ctx, employeeId, newlyOccupied(before.o, after.o));
  await assertCapacity(tx, ctx, employeeId, exitBusinessId, newlyOccupied(before.p, after.p), confirmed);
}
