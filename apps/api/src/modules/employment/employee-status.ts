/**
 * 人员状态 / 入职状态的业务流转端口（F-022；docs/02_业务建模/15 §9、29 PB-R7、34 EN-R8～R11）。
 * 状态随承载它的任职版本生效而切换：每次流转追加版本（记录快照或申请载荷），不原地改写，不另建“变更前”列。
 * 未经这里显式给出的追加一律继承上一版本（record-store.ts insertEmploymentRow + 迁移 0059 触发器）。
 * 端口接线：添加待入职、办理入职生效、延期 / 取消 / 改期入职由 R2-T01 接入；转正审批与调整试用信息由 R2-T02 接入。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import {
  EMPLOYEE_STATUS,
  ENTRY_STATUS,
  tenantLocalDate,
  type EmployeeStatusCode,
  type EntryStatusCode,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { auditEmployment, requireLinkedEmploymentRecord, requireScopedEmploymentObject } from './context.js';
import { loadEmploymentRecord } from './read-model.js';
import {
  bumpEmploymentBusiness,
  camelRow,
  insertEmploymentRow,
  lockEmploymentBusiness,
  rowsOf,
  snapshotFields,
  type EmploymentPayloadRow,
  type LockedEmploymentBusiness,
} from './record-store.js';
import { lockTransferBusiness } from './transfer-locks.js';
import type { BusinessKind, EmploymentContext, EmploymentRecord } from './types.js';

export interface VersionStatus {
  readonly employeeStatus: EmployeeStatusCode;
  readonly entryStatus: EntryStatusCode | null;
}

/** 入职写入端口（R2-T01 接线）：只由可信业务入口传入，不开放给请求体（15 §9.3）。 */
export interface EntryOptions {
  /** 添加待入职：待入职 + 入职状态正常。 */
  readonly pendingEntry?: boolean;
  /** 办理入职时是否有试用期：有为试用，否则正式（34 EN-R11）。 */
  readonly probation?: boolean;
}

const ENTRY_KINDS: readonly BusinessKind[] = ['hire', 'rehire', 'retire_rehire'];
const ENTRY_TARGETS = {
  normal: ENTRY_STATUS.normal,
  cancelled: ENTRY_STATUS.cancelled,
  postponed: ENTRY_STATUS.postponed,
};
export type EntryTarget = keyof typeof ENTRY_TARGETS;

/**
 * 新业务首版的显式状态。只有入职类带入职端口参数时需要显式给出；其余（入职默认正式、转正正式、离职离职、退休退休、
 * 其他继承前一条）由触发器统一决定，避免两处口径。
 */
export function entryStatusFor(kind: BusinessKind, entry?: EntryOptions): VersionStatus | undefined {
  if (!entry || !ENTRY_KINDS.includes(kind)) return undefined;
  if (entry.pendingEntry) return { employeeStatus: EMPLOYEE_STATUS.pendingEntry, entryStatus: ENTRY_STATUS.normal };
  return { employeeStatus: entry.probation ? EMPLOYEE_STATUS.probation : EMPLOYEE_STATUS.regular, entryStatus: null };
}

interface LockedRecord {
  readonly business: LockedEmploymentBusiness;
  readonly record: EmploymentRecord;
}

/** 取锁顺序同任职编辑（F-008）：调动参与者 → 员工 → 业务头；再按当前范围校验（DEC-177 / 193）。 */
async function lockPendingEntry(tx: Tx, ctx: EmploymentContext, recordId: string): Promise<LockedRecord> {
  await lockTransferBusiness(tx, ctx, recordId);
  const business = await lockEmploymentBusiness(tx, ctx, recordId);
  const record = await loadEmploymentRecord(tx, ctx.tenantId, recordId, tenantLocalDate(ctx.now, ctx.timezone));
  if (business.state !== 'effective' || !record) throw new AppError('CONFLICT', '只能流转有效任职记录');
  await requireScopedEmploymentObject(tx, ctx, record.employeeId, record.fields.departmentId, record.id);
  if (!ENTRY_KINDS.includes(record.kind) || record.employeeStatus !== EMPLOYEE_STATUS.pendingEntry)
    throw new AppError('CONFLICT', '只有待入职的入职记录可以办理此操作', { reason: 'NOT_PENDING_ENTRY' });
  return { business, record };
}

/**
 * 延期 / 取消 / 改期恢复入职（34 EN-R8、EN-R9；R2-T01 接线）：只改入职状态，人员状态仍为待入职。
 * 已取消的人可通过改期恢复（取消 → 延期 / 正常）；改期本身移动的入职日期由 R2-T01 的业务负责。
 */
export async function changePendingEntryStatus(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  target: EntryTarget,
): Promise<EmploymentRecord> {
  if (!Object.hasOwn(ENTRY_TARGETS, target)) throw new AppError('VALIDATION_FAILED', '入职状态不合法');
  const { business, record } = await lockPendingEntry(tx, ctx, recordId);
  const entryStatus = ENTRY_TARGETS[target];
  if (record.entryStatus === entryStatus) return record;
  await appendStatusSnapshot(tx, ctx, business, record, { employeeStatus: record.employeeStatus, entryStatus });
  return reloadRecord(tx, ctx, recordId);
}

/** 办理入职生效（34 EN-R11；R2-T01 接线）：待入职 → 有试用期为试用，否则正式；同周期在后的待入职版本一并更新。 */
export async function completePendingEntry(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  options: { readonly probation: boolean },
): Promise<EmploymentRecord> {
  const { business, record } = await lockPendingEntry(tx, ctx, recordId);
  if (record.entryStatus === ENTRY_STATUS.cancelled)
    throw new AppError('CONFLICT', '已取消入职，请先改期恢复', { reason: 'ENTRY_CANCELLED' });
  const employeeStatus = options.probation ? EMPLOYEE_STATUS.probation : EMPLOYEE_STATUS.regular;
  await appendStatusSnapshot(tx, ctx, business, record, { employeeStatus, entryStatus: record.entryStatus });
  await propagateEmployeeStatus(tx, ctx, record, record.employeeStatus, employeeStatus);
  return reloadRecord(tx, ctx, recordId);
}

async function reloadRecord(tx: Tx, ctx: EmploymentContext, recordId: string): Promise<EmploymentRecord> {
  const saved = await loadEmploymentRecord(tx, ctx.tenantId, recordId, tenantLocalDate(ctx.now, ctx.timezone));
  if (!saved) throw new AppError('SERVICE_UNAVAILABLE', '任职记录保存结果不可用');
  return saved;
}

/** 生效记录的状态流转：以记录当前字段为起点追加快照，字段级审计（DEC-216）与业务同事务。 */
async function appendStatusSnapshot(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  record: EmploymentRecord,
  status: VersionStatus,
): Promise<void> {
  const versionId = await appendStatusVersion(tx, ctx, business.payload, record, status, record.id);
  await auditEmployment(
    tx,
    ctx,
    'employment.record.status',
    'employment-record',
    record.id,
    { employeeStatus: record.employeeStatus, entryStatus: record.entryStatus },
    { employeeStatus: status.employeeStatus, entryStatus: status.entryStatus },
    versionId,
  );
  await bumpEmploymentBusiness(tx, ctx, business);
}

async function appendStatusVersion(
  tx: Tx,
  ctx: EmploymentContext,
  payload: EmploymentPayloadRow,
  record: EmploymentRecord | null,
  status: VersionStatus,
  triggerBusinessId: string,
): Promise<string> {
  const { fields, ...metadata } = payload;
  const id = randomUUID();
  await insertEmploymentRow(
    tx,
    'employment_payload_versions',
    {
      ...metadata,
      ...(record ? record.fields : fields),
      customFields: record ? record.customFields : payload.customFields,
      id,
      versionNo: payload.versionNo + 1,
      previousVersionId: payload.id,
      commandId: ctx.commandId,
      triggerBusinessId,
      isRecordSnapshot: record !== null,
      deferredFieldCodes: record ? [] : payload.deferredFieldCodes,
      createdAt: ctx.now.toISOString(),
    },
    status,
  );
  return id;
}

interface PropagationTarget {
  readonly payload: EmploymentPayloadRow;
  readonly state: string;
  readonly employeeStatus: number;
  readonly entryStatus: number | null;
  readonly departmentId: string | null;
}

/**
 * 29 PB-R7：转正记录把人员状态由试用改为正式，时间轴上晚于它的后续版本一并改为正式（办理入职同理：待入职 → 试用 /
 * 正式）。同周期内状态等于原值的后续生效记录追加快照、在途申请追加载荷版本；不同值（如离职）不动。
 * 联动改写按 DEC-178：后续记录对操作人可见才改，不可见整单拒绝。
 */
export async function propagateEmployeeStatus(
  tx: Tx,
  ctx: EmploymentContext,
  source: Pick<EmploymentRecord, 'id' | 'employeeId' | 'staffId' | 'effectiveDate'>,
  from: number,
  to: EmployeeStatusCode,
): Promise<void> {
  if (from === to) return;
  for (const target of await propagationTargets(tx, ctx, source, from)) {
    await requireLinkedEmploymentRecord(tx, ctx, source.employeeId, target.departmentId, target.payload.businessId);
    const effective = target.state === 'effective';
    const record = effective
      ? await loadEmploymentRecord(tx, ctx.tenantId, target.payload.businessId, target.payload.effectiveDate)
      : null;
    const status = { employeeStatus: to, entryStatus: target.entryStatus as EntryStatusCode | null };
    const versionId = await appendStatusVersion(tx, ctx, target.payload, record, status, source.id);
    await tx.execute(sql`UPDATE employment_business_objects SET revision=revision+1
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${source.employeeId}::uuid
        AND id=${target.payload.businessId}::uuid`);
    await auditEmployment(
      tx,
      ctx,
      'employment.forward-update',
      effective ? 'employment-record' : 'employment-business',
      target.payload.businessId,
      { employeeStatus: target.employeeStatus },
      { employeeStatus: to },
      versionId,
    );
  }
}

/** 调用方已持员工锁；候选限本周期、排在源记录之后，状态按当前快照（生效记录）或最新载荷（在途申请）比较。 */
async function propagationTargets(
  tx: Tx,
  ctx: EmploymentContext,
  source: Pick<EmploymentRecord, 'id' | 'employeeId' | 'staffId' | 'effectiveDate'>,
  from: number,
): Promise<PropagationTarget[]> {
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
    WITH point AS (SELECT start_date, sort_order FROM employment_timeline
      WHERE tenant_id=${ctx.tenantId} AND record_id=${source.id}::uuid)
    SELECT p.*, s.state,
      COALESCE(st.employee_status, p.employee_status) AS current_status,
      CASE WHEN st.employee_status IS NULL THEN p.entry_status ELSE st.entry_status END AS current_entry,
      COALESCE(snap.department_id, r.department_id, p.department_id) AS current_department
    FROM employment_business_objects b
    JOIN LATERAL (SELECT * FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id
      AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id
      AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
    LEFT JOIN employment_records r ON r.tenant_id=b.tenant_id AND r.id=b.id
    LEFT JOIN employment_timeline t ON t.tenant_id=b.tenant_id AND t.record_id=b.id
    LEFT JOIN LATERAL employment_record_status(b.tenant_id, r.id) st ON true
    LEFT JOIN LATERAL (SELECT v.department_id FROM employment_payload_versions v WHERE v.tenant_id=b.tenant_id
      AND v.business_id=b.id AND v.is_record_snapshot ORDER BY v.version_no DESC LIMIT 1) snap ON true
    CROSS JOIN point
    WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${source.employeeId}::uuid AND b.id<>${source.id}::uuid
      AND ((s.state='effective' AND r.staff_id=${source.staffId}::uuid
          AND (t.start_date,t.sort_order)>(point.start_date,point.sort_order))
        OR (s.state IN ('draft','in_review','approved','rejected') AND r.id IS NULL
          AND p.selected_staff_id=${source.staffId}::uuid AND p.effective_date>${source.effectiveDate}::date))
      AND COALESCE(st.employee_status, p.employee_status)=${from}
    ORDER BY p.effective_date, t.sort_order NULLS LAST, b.id LIMIT 1001
  `),
  );
  if (rows.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '人员状态联动目标超过单次处理上限');
  return rows.map((raw) => {
    const { state, currentStatus, currentEntry, currentDepartment, ...row } = camelRow(raw);
    return {
      payload: { ...row, fields: snapshotFields(row) } as unknown as EmploymentPayloadRow,
      state: String(state),
      employeeStatus: Number(currentStatus),
      entryStatus: currentEntry === null ? null : Number(currentEntry),
      departmentId: (currentDepartment as string | null) ?? null,
    };
  });
}
