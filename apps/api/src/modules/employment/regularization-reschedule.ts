/**
 * 转正改期（PB-R13；DEC-589，#391 第 1 轮审查 P2-1）：转正单专用命令，复用迟到改期（late-transfer.ts）的重排机制——
 * 追加一个载荷版本（人工改期：计划日 = 新日期）、重建时间轴投影，业务 ID 不变，审计写原日期 → 新日期，不原地覆盖。
 * - 只对已生效（含直接办理未到日）与审批通过的转正单开放；通用编辑入口仍不能改日期（RECORD_DATE_IMMUTABLE），DEC-231 不变；
 * - 新日期须在本任职周期内：不早于入职日期，不晚于已生效的离职 / 退休（400 REGULARIZATION_DATE_OUT_OF_CYCLE）；
 * - 新旧日期之间有离职、退休、另一条转正或入职类记录（含在途申请）→ 409 REGULARIZATION_RESCHEDULE_BLOCKED，列出冲突；
 * - 跨过的调动等记录重算人员状态：提前 → 区间内改为转正后的状态（正式）；推后 → 区间内回退为转正前一条的状态（试用）。
 *   在途申请按生效日落在区间内判定（同日先后由落地时 DEC-108 决定，冲突检查按闭区间从严）。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { auditEmployment, requireScopedEmploymentObject } from './context.js';
import { ENTRY_LIKE_KINDS, propagateEmployeeStatus, type TimelinePoint } from './employee-status.js';
import { personnelHooks } from './personnel-hooks.js';
import { findPredecessor, loadEmploymentRecord } from './read-model.js';
import {
  bumpEmploymentBusiness,
  insertEmploymentRow,
  lockEmploymentBusiness,
  rowsOf,
  type LockedEmploymentBusiness,
} from './record-store.js';
import { insertEmploymentTimeline, timelinePosition } from './timeline.js';
import type { EmploymentBusiness, EmploymentContext, EmploymentRecord } from './types.js';
import { requireSavedBusiness, validateTransferReposition } from './write-service.js';

/** 区间内出现就拒绝改期的业务：本身决定人员状态，跨过它会改变周期结构或状态来源。 */
const BLOCKING_KINDS = ['leave', 'retirement', 'regularization', ...ENTRY_LIKE_KINDS];
const kindList = sql.join(
  BLOCKING_KINDS.map((kind) => sql`${kind}`),
  sql`, `,
);

export interface RescheduleConflict {
  readonly id: string;
  readonly kind: string;
  readonly effectiveDate: string;
  /** true = 已落地的任职记录；false = 在途申请。 */
  readonly materialized: boolean;
}

async function cycleBounds(tx: Tx, ctx: EmploymentContext, employeeId: string, staffId: string) {
  const [row] = rowsOf<{ entryDate: string; endDate: string | null }>(
    await tx.execute(sql`SELECT min(r.entry_date)::text AS "entryDate",
        min(t.start_date) FILTER (WHERE r.kind IN ('leave', 'retirement'))::text AS "endDate"
      FROM employment_records r JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
      WHERE r.tenant_id=${ctx.tenantId} AND r.employee_id=${employeeId}::uuid AND r.staff_id=${staffId}::uuid`),
  );
  return row!;
}

async function assertInCycle(tx: Tx, ctx: EmploymentContext, employeeId: string, staffId: string, date: string) {
  const { entryDate, endDate } = await cycleBounds(tx, ctx, employeeId, staffId);
  if (date < entryDate || (endDate && date >= endDate))
    throw new AppError('VALIDATION_FAILED', '转正日期须在本任职周期内', {
      reason: 'REGULARIZATION_DATE_OUT_OF_CYCLE',
      entryDate,
      cycleEndDate: endDate,
    });
}

/** 新旧位置之间的冲突：已落地记录按时间轴位置判，在途申请按生效日闭区间判。 */
async function windowConflicts(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  oldPoint: TimelinePoint,
  newPoint: TimelinePoint,
): Promise<RescheduleConflict[]> {
  const earlier = newPoint.date < oldPoint.date;
  const range = earlier
    ? sql`(t.start_date,t.sort_order)>=(${newPoint.date}::date,${newPoint.order})
        AND (t.start_date,t.sort_order)<(${oldPoint.date}::date,${oldPoint.order})`
    : sql`(t.start_date,t.sort_order)>(${oldPoint.date}::date,${oldPoint.order})
        AND (t.start_date,t.sort_order)<(${newPoint.date}::date,${newPoint.order})`;
  const [low, high] = earlier ? [newPoint.date, oldPoint.date] : [oldPoint.date, newPoint.date];
  return rowsOf<RescheduleConflict>(
    await tx.execute(sql`
    SELECT t.record_id AS id, r.kind, t.start_date::text AS "effectiveDate", true AS materialized
    FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${business.employeeId}::uuid
      AND t.record_id<>${business.id}::uuid
      AND r.kind IN (${kindList}) AND ${range}
    UNION ALL
    SELECT b.id, p.kind, p.effective_date::text, false
    FROM employment_business_objects b
    JOIN LATERAL (SELECT kind, effective_date FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
    WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${business.employeeId}::uuid AND b.id<>${business.id}::uuid
      AND s.state IN ('draft','in_review','approved','rejected') AND p.kind IN (${kindList})
      AND NOT EXISTS (SELECT 1 FROM employment_records x WHERE x.tenant_id=b.tenant_id AND x.id=b.id)
      AND p.effective_date BETWEEN ${low}::date AND ${high}::date
    ORDER BY 3, 1 LIMIT 101`),
  );
}

/**
 * 改期版本：先追加一个人工版本（命令号 / 触发业务都为空，计划生效日随之改为新日期，迁移 0130 触发器；约束 command_pair），
 * 已落地的再追加一个本命令的记录快照（快照须带命令号，计划日沿用上一版本即新日期），记录字段不变。
 */
async function appendRescheduledPayload(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  record: EmploymentRecord | null,
  effectiveDate: string,
) {
  const append = async (overrides: Record<string, unknown>) => {
    const previous = business.payload;
    const next = {
      ...previous,
      id: randomUUID(),
      versionNo: previous.versionNo + 1,
      previousVersionId: previous.id,
      effectiveDate,
      ...overrides,
    } as typeof previous;
    const { fields, ...metadata } = next;
    await insertEmploymentRow(tx, 'employment_payload_versions', {
      ...metadata,
      ...fields,
      createdAt: ctx.now.toISOString(),
    });
    business.payload = next;
  };
  await append({ commandId: null, triggerBusinessId: null, isRecordSnapshot: false });
  if (record)
    await append({
      commandId: ctx.commandId,
      triggerBusinessId: business.id,
      fields: record.fields,
      customFields: record.customFields,
      isRecordSnapshot: true,
      deferredFieldCodes: [],
    });
}

/** 把已落地记录的时间轴行移到新日期：前一条区间接到后一条（同 late-transfer），再按新位置插入。 */
async function moveTimeline(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  record: EmploymentRecord,
) {
  const [old] = rowsOf<{ startDate: string; sortOrder: number }>(
    await tx.execute(sql`SELECT start_date::text AS "startDate", sort_order AS "sortOrder" FROM employment_timeline
      WHERE tenant_id=${ctx.tenantId} AND record_id=${business.id}::uuid`),
  );
  const [before] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT record_id AS id FROM employment_timeline WHERE tenant_id=${ctx.tenantId}
      AND employee_id=${business.employeeId}::uuid
      AND (start_date,sort_order)<(${old!.startDate}::date,${old!.sortOrder})
      ORDER BY start_date DESC, sort_order DESC LIMIT 1`),
  );
  const [after] = rowsOf<{ date: string }>(
    await tx.execute(sql`SELECT start_date::text AS date FROM employment_timeline WHERE tenant_id=${ctx.tenantId}
      AND employee_id=${business.employeeId}::uuid
      AND (start_date,sort_order)>(${old!.startDate}::date,${old!.sortOrder})
      ORDER BY start_date, sort_order LIMIT 1`),
  );
  await tx.execute(
    sql`DELETE FROM employment_timeline WHERE tenant_id=${ctx.tenantId} AND record_id=${business.id}::uuid`,
  );
  if (before)
    await tx.execute(sql`UPDATE employment_timeline
      SET valid_during=daterange(start_date,${after?.date ?? null}::date,'[)')
      WHERE tenant_id=${ctx.tenantId} AND record_id=${before.id}::uuid`);
  await validateTransferReposition(tx, ctx, business, record);
  await insertEmploymentTimeline(
    tx,
    ctx,
    business.employeeId,
    business.id,
    record.staffId,
    business.payload.effectiveDate,
  );
}

async function currentPoint(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<TimelinePoint | null> {
  const [row] = rowsOf<{ date: string; order: number }>(
    await tx.execute(sql`SELECT start_date::text AS date, sort_order AS "order" FROM employment_timeline
      WHERE tenant_id=${ctx.tenantId} AND record_id=${businessId}::uuid`),
  );
  return row ? { date: row.date, order: Number(row.order) } : null;
}

/** 区间内记录的人员状态：推后时改前回退（区间上界 = 新位置），提前时改后按新位置向后传播（区间上界 = 原位置）。 */
async function recomputeWindow(
  tx: Tx,
  ctx: EmploymentContext,
  record: EmploymentRecord,
  oldPoint: TimelinePoint,
  newPoint: TimelinePoint,
  move: () => Promise<void>,
) {
  const earlier = newPoint.date < oldPoint.date;
  if (!earlier) {
    // 推后：区间内的版本原先继承本转正（正式），回退为转正前一条的状态；先回退再移动，源位置仍是原位置
    const prior = await findPredecessor(tx, ctx.tenantId, record.employeeId, oldPoint.date, oldPoint.order);
    if (prior && prior.staffId === record.staffId)
      await propagateEmployeeStatus(tx, ctx, record, record.employeeStatus, prior.employeeStatus, newPoint);
    await move();
    return;
  }
  await move();
  const moved = await loadEmploymentRecord(tx, ctx.tenantId, record.id, record.effectiveDate);
  const point = await currentPoint(tx, ctx, record.id);
  const prior = point && (await findPredecessor(tx, ctx.tenantId, record.employeeId, point.date, point.order));
  if (moved && prior && prior.staffId === record.staffId)
    await propagateEmployeeStatus(
      tx,
      ctx,
      { ...moved, effectiveDate: point!.date },
      prior.employeeStatus,
      moved.employeeStatus,
      oldPoint,
    );
}

export async function rescheduleRegularization(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  effectiveDate: string,
): Promise<EmploymentBusiness> {
  const business = await lockEmploymentBusiness(tx, ctx, businessId);
  if (business.payload.kind !== 'regularization')
    throw new AppError('CONFLICT', '只有转正单可以修改转正日期', { reason: 'NOT_REGULARIZATION' });
  if (!['effective', 'approved'].includes(business.state))
    throw new AppError('CONFLICT', '只有已生效或审批通过的转正单可以修改转正日期', {
      reason: 'REGULARIZATION_NOT_RESCHEDULABLE',
    });
  const original = business.payload.effectiveDate;
  if (effectiveDate === original) return requireSavedBusiness(tx, ctx, businessId);
  const record = await loadEmploymentRecord(tx, ctx.tenantId, businessId, tenantLocalDate(ctx.now, ctx.timezone));
  // DEC-193：直接操作按写入口径复核（记录部门 ∧ 员工），与待入职动作同一口径
  await requireScopedEmploymentObject(
    tx,
    ctx,
    business.employeeId,
    record?.fields.departmentId ?? business.payload.fields.departmentId,
    businessId,
  );
  const staffId = record?.staffId ?? business.payload.selectedStaffId;
  if (!staffId) throw new AppError('SERVICE_UNAVAILABLE', '转正单缺少任职周期');
  await assertInCycle(tx, ctx, business.employeeId, staffId, effectiveDate);
  const oldPoint =
    (await currentPoint(tx, ctx, businessId)) ??
    (await timelinePosition(tx, ctx, business.employeeId, original, businessId));
  const newPoint = await timelinePosition(tx, ctx, business.employeeId, effectiveDate, businessId);
  const conflicts = await windowConflicts(tx, ctx, business, oldPoint, newPoint);
  if (conflicts.length)
    throw new AppError('CONFLICT', '新旧转正日期之间有离职、转正或入职记录，不能改期', {
      reason: 'REGULARIZATION_RESCHEDULE_BLOCKED',
      conflicts: conflicts.slice(0, 100),
      truncated: conflicts.length > 100,
    });
  await appendRescheduledPayload(tx, ctx, business, record, effectiveDate);
  await auditEmployment(
    tx,
    ctx,
    'employment.regularization.rescheduled',
    'employment-business',
    businessId,
    { effectiveDate: original },
    { effectiveDate, versionNo: business.payload.versionNo },
    business.payload.id,
  );
  if (record) {
    await recomputeWindow(tx, ctx, record, oldPoint, newPoint, () => moveTimeline(tx, ctx, business, record));
    await personnelHooks.sync(tx, ctx, business.employeeId, businessId, 'regularization', effectiveDate);
  }
  await bumpEmploymentBusiness(tx, ctx, business);
  return requireSavedBusiness(tx, ctx, businessId);
}
