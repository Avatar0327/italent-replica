/**
 * 转正改期（PB-R13；DEC-589，#391 第 1 轮审查 P2-1）：转正单专用命令，复用迟到改期（late-transfer.ts）的重排机制——
 * 追加一个载荷版本（人工改期：计划日 = 新日期）、重建时间轴投影，业务 ID 不变，审计写原日期 → 新日期，不原地覆盖；
 * 已落地的按新位置的前驱重算继承字段后追加记录快照（显式填写的保留）。
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
import { derivationFields } from './field-derivations.js';
import { INHERITED_FIELDS } from './fields.js';
import { findPredecessor, loadEmploymentRecord } from './read-model.js';
import {
  bumpEmploymentBusiness,
  insertEmploymentRow,
  lockEmploymentBusiness,
  rowsOf,
  type EmploymentPayloadRow,
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

/** 追加一个改期载荷版本（生效日 = 新日期；人工版本的计划日随之改为新日期，派生版本沿用，迁移 0130 触发器）。 */
async function appendRescheduledVersion(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  effectiveDate: string,
  overrides: Partial<EmploymentPayloadRow>,
) {
  const previous = business.payload;
  const next: EmploymentPayloadRow = {
    ...previous,
    id: randomUUID(),
    versionNo: previous.versionNo + 1,
    previousVersionId: previous.id,
    effectiveDate,
    ...overrides,
  };
  const { fields, ...metadata } = next;
  await insertEmploymentRow(tx, 'employment_payload_versions', {
    ...metadata,
    ...fields,
    createdAt: ctx.now.toISOString(),
  });
  business.payload = next;
}

/**
 * 按新位置的前驱重新解析继承字段（#391 第 2 轮 P2-R2-1）：业务显式填写的字段、派生字段与场景留空字段（DEC-163）保留，
 * 其余继承字段与可继承的自定义字段取新前驱的值（不同周期取空），与按新日期办理时 prepareInheritance 的口径一致。
 */
function reinherited(payload: EmploymentPayloadRow, record: EmploymentRecord, predecessor: EmploymentRecord | null) {
  const previous = predecessor?.staffId === record.staffId ? predecessor : null;
  const form = payload.formSnapshot;
  const explicit = new Set(payload.explicitFieldCodes);
  for (const origin of form.fieldDerivations ?? []) explicit.add(`preset:${derivationFields(origin).field}`);
  const excluded = new Set(form.excludedAutofillFields ?? []);
  const fields = { ...record.fields };
  for (const field of INHERITED_FIELDS) {
    const code = `preset:${field}`;
    if (explicit.has(code) || (excluded.has(field) && form.fieldModes[code] === 'editable')) continue;
    Object.assign(fields, { [field]: previous?.fields[field] ?? null });
  }
  const customFields = { ...record.customFields };
  for (const id of Object.keys(customFields)) {
    const mode = form.fieldModes[`custom:${id}`];
    const inherits = form.customInheritance[id] || mode === 'readonly' || mode === 'hidden';
    if (inherits && !explicit.has(`custom:${id}`)) customFields[id] = previous?.customFields[id] ?? null;
  }
  return { fields, customFields };
}

/** 摘下已落地记录的时间轴行：前一条区间接到后一条（同 late-transfer）。 */
async function detachTimeline(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness, old: TimelinePoint) {
  const [before] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT record_id AS id FROM employment_timeline WHERE tenant_id=${ctx.tenantId}
      AND employee_id=${business.employeeId}::uuid AND (start_date,sort_order)<(${old.date}::date,${old.order})
      ORDER BY start_date DESC, sort_order DESC LIMIT 1`),
  );
  const [after] = rowsOf<{ date: string }>(
    await tx.execute(sql`SELECT start_date::text AS date FROM employment_timeline WHERE tenant_id=${ctx.tenantId}
      AND employee_id=${business.employeeId}::uuid AND (start_date,sort_order)>(${old.date}::date,${old.order})
      ORDER BY start_date, sort_order LIMIT 1`),
  );
  await tx.execute(
    sql`DELETE FROM employment_timeline WHERE tenant_id=${ctx.tenantId} AND record_id=${business.id}::uuid`,
  );
  if (before)
    await tx.execute(sql`UPDATE employment_timeline
      SET valid_during=daterange(start_date,${after?.date ?? null}::date,'[)')
      WHERE tenant_id=${ctx.tenantId} AND record_id=${before.id}::uuid`);
}

async function currentPoint(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<TimelinePoint | null> {
  const [row] = rowsOf<{ date: string; order: number }>(
    await tx.execute(sql`SELECT start_date::text AS date, sort_order AS "order" FROM employment_timeline
      WHERE tenant_id=${ctx.tenantId} AND record_id=${businessId}::uuid`),
  );
  return row ? { date: row.date, order: Number(row.order) } : null;
}

/**
 * 已落地记录移到目标位置。区间内记录的人员状态：推后时先按原位置回退为转正前一条的状态（上界 = 目标位置）；
 * 提前时移动后从目标位置向后传播转正后的状态（上界 = 原位置）。继承字段按目标位置的前驱重算后追加本命令的记录快照；
 * 实际插入点必须等于预算的目标位置，否则冲突检测与重算上界失效，整笔拒绝（P2-R2-2）。
 */
async function relocateRecord(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  record: EmploymentRecord,
  oldPoint: TimelinePoint,
  target: TimelinePoint,
) {
  const earlier = target.date < oldPoint.date;
  if (!earlier) {
    const prior = await findPredecessor(tx, ctx.tenantId, record.employeeId, oldPoint.date, oldPoint.order);
    if (prior && prior.staffId === record.staffId)
      await propagateEmployeeStatus(tx, ctx, record, record.employeeStatus, prior.employeeStatus, target);
  }
  await detachTimeline(tx, ctx, business, oldPoint);
  const predecessor = await findPredecessor(tx, ctx.tenantId, record.employeeId, target.date, target.order);
  const moved = { ...record, ...reinherited(business.payload, record, predecessor) };
  await validateTransferReposition(tx, ctx, business, moved);
  await insertEmploymentTimeline(tx, ctx, business.employeeId, business.id, record.staffId, target.date);
  const landed = await currentPoint(tx, ctx, business.id);
  if (landed?.date !== target.date || landed.order !== target.order)
    throw new AppError('SERVICE_UNAVAILABLE', '转正改期的插入位置与预算位置不一致');
  await appendRescheduledVersion(tx, ctx, business, target.date, {
    commandId: ctx.commandId,
    triggerBusinessId: business.id,
    fields: moved.fields,
    customFields: moved.customFields,
    isRecordSnapshot: true,
    deferredFieldCodes: [],
  });
  if (earlier && predecessor && predecessor.staffId === record.staffId)
    await propagateEmployeeStatus(
      tx,
      ctx,
      { ...record, effectiveDate: target.date },
      predecessor.employeeStatus,
      record.employeeStatus,
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
  // P2-R2-2：目标位置按新计划日预算（写入前），冲突检测、状态重算上界与最终插入共用这一个位置
  const target = await timelinePosition(tx, ctx, business.employeeId, effectiveDate, businessId, effectiveDate);
  const conflicts = await windowConflicts(tx, ctx, business, oldPoint, target);
  if (conflicts.length)
    throw new AppError('CONFLICT', '新旧转正日期之间有离职、转正或入职记录，不能改期', {
      reason: 'REGULARIZATION_RESCHEDULE_BLOCKED',
      conflicts: conflicts.slice(0, 100),
      truncated: conflicts.length > 100,
    });
  // 人工改期版本：命令号 / 触发业务都为空（约束 command_pair），计划日 = 新日期；已落地的随后追加记录快照
  await appendRescheduledVersion(tx, ctx, business, effectiveDate, {
    commandId: null,
    triggerBusinessId: null,
    isRecordSnapshot: false,
  });
  if (record) {
    await relocateRecord(tx, ctx, business, record, oldPoint, target);
    await personnelHooks.sync(tx, ctx, business.employeeId, businessId, 'regularization', effectiveDate);
  }
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
  await bumpEmploymentBusiness(tx, ctx, business);
  return requireSavedBusiness(tx, ctx, businessId);
}
