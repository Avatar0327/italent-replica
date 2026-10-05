import { reconcileCompletion, openCompletion } from '../transfer/completion.js';
import { queueTransferLinkage, validateTransferSubordinates } from './transfer-linkage.js';
import { lockTransferParticipants } from './transfer-locks.js';
import { assertEstablishmentCapacity, type EstablishmentWarning } from './activation-checks.js';
import { personnelHooks } from './personnel-hooks.js';
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { clearedTransferFields, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { readEmploymentSettings } from './configuration.js';
import { auditEmployment, requireScopedEmploymentObject } from './context.js';
import { assertNotBeforeCurrentCycle } from './cycles.js';
import { forwardUpdateEmployment } from './forward-update.js';
import type { ForwardValues } from './forward-rules.js';
import { emptyPresetFields } from './types.js';
import { normalizeBusinessPatch, normalizeEmploymentInput } from './fields.js';
import {
  prepareInheritance,
  prepareEmploymentPatch,
  resolveEffectiveInheritance,
  type PreparedInheritance,
} from './inheritance.js';
import { findPredecessor, loadEmploymentBusiness } from './read-model.js';
import {
  bumpEmploymentBusiness,
  bumpEmploymentEmployee,
  insertEmploymentRow,
  lockEmploymentBusiness,
  lockEmploymentEmployee,
  rowsOf,
  type EmploymentPayloadRow,
  type LockedEmploymentBusiness,
} from './record-store.js';
import { newRecordReporting, validateNewEmploymentReferences } from './references.js';
import { windowBefore } from './reporting-cycle.js';
import { assertRequiredTransferFields } from '../transfer/required-fields.js';
import {
  employmentTimelineNeighbors,
  insertEmploymentTimeline,
  timelinePosition,
  type TimelinePosition,
} from './timeline.js';
import {
  type BusinessKind,
  type ChangeType,
  type EmployType,
  type EmploymentBusiness,
  type EmploymentBusinessInput,
  type EmploymentBusinessPatch,
  type EmploymentContext,
  type EmploymentRecord,
  type NormalizedEmploymentInput,
  type PresetFields,
} from './types.js';

export const NEW_CYCLE_KINDS: readonly BusinessKind[] = ['hire', 'rehire', 'retire_rehire'];

interface EmploymentCycleRow {
  id: string;
  entryDate: string;
  entryType: BusinessKind;
  employType: EmployType;
}

interface SelectedEmploymentCycle {
  cycle: EmploymentCycleRow;
  predecessor: EmploymentRecord | null;
}

export interface CreateEmploymentOptions {
  readonly forwardUpdate?: boolean;
  /** 变动类型只由可信的系统联动传入（如职位变更同步直线经理，F-006），不开放给请求体。 */
  readonly changeType?: ChangeType;
  readonly establishmentWarnings?: EstablishmentWarning[];
}

export async function createEmploymentBusiness(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: EmploymentBusinessInput,
  options: CreateEmploymentOptions = {},
): Promise<EmploymentBusiness> {
  const normalized = normalizeEmploymentInput(ctx, input);
  if (normalized.kind === 'transfer')
    await lockTransferParticipants(tx, ctx, employeeId, normalized.fields.addedSubordinateIds ?? []);
  const employee = await lockEmploymentEmployee(tx, ctx, employeeId, ctx.expectedRevision);
  await assertNotBeforeCurrentCycle(tx, ctx, employee.id, normalized);
  await assertBusinessSequence(tx, ctx, employee.id, normalized);
  assertEmployTypeUsage(normalized);
  await assertDirectTransferAllowed(tx, ctx, employee.id, normalized);
  const selected = NEW_CYCLE_KINDS.includes(normalized.kind)
    ? undefined
    : await selectEmploymentCycle(tx, ctx, employee.id, normalized);
  const prepared = await prepareInheritance(tx, ctx, {
    ...normalized,
    employeeId: employee.id,
    staffId: selected?.cycle.id,
  });
  const effective = await resolveEffectiveInheritance(tx, ctx, prepared, {
    staffId: selected?.cycle.id ?? '',
    predecessor: selected?.predecessor ?? null,
  });
  await validatePreparedEmployment(tx, ctx, employee.id, normalized.kind, prepared, effective.fields);
  const id = randomUUID();
  await assertEstablishmentCapacity(
    tx,
    ctx,
    {
      businessId: id,
      employeeId: employee.id,
      kind: normalized.kind,
      effectiveDate: normalized.effectiveDate,
      fields: effective.fields,
      departmentId: effective.fields.departmentId,
      positionId: effective.fields.positionId,
    },
    options.establishmentWarnings,
  );
  await insertEmploymentRow(tx, 'employment_business_objects', {
    id,
    tenantId: ctx.tenantId,
    employeeId: employee.id,
    revision: 1,
    createdAt: ctx.now.toISOString(),
  });
  const payload = await appendEmploymentPayload(
    tx,
    ctx,
    employee.id,
    id,
    1,
    normalized,
    prepared,
    null,
    selected?.cycle.id,
    options.changeType,
  );
  const business: LockedEmploymentBusiness = {
    id,
    employeeId: employee.id,
    revision: 1,
    employee,
    payload,
    state: normalized.mode === 'direct' ? 'effective' : 'draft',
    eventNo: 0,
  };
  if (normalized.mode === 'direct') await materializeEmploymentRecord(tx, ctx, business, options);
  await appendEmploymentState(tx, ctx, business, business.state);
  await bumpEmploymentEmployee(tx, ctx, employee);
  await auditEmployment(tx, ctx, 'employment.business.create', 'employment-business', id, null, payloadAudit(payload));
  return requireSavedBusiness(tx, ctx, id);
}

export async function updateEmploymentBusiness(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  input: EmploymentBusinessPatch,
  options: { readonly approvalEdit?: boolean } = {},
): Promise<EmploymentBusiness> {
  const patch = normalizeBusinessPatch(input);
  const business = await lockEmploymentBusiness(tx, ctx, id);
  // DEC-053：被驳回的申请可在同一单上修改后重提；审批中修改由审批中心按节点可编辑字段放行（REQ-APV-003 R2）。
  if (business.payload.mode !== 'application' || !['draft', 'in_review', 'rejected'].includes(business.state)) {
    throw new AppError('CONFLICT', '只有草稿、审批中或被驳回的申请可以修改', { reason: 'PAYLOAD_IMMUTABLE' });
  }
  // 审批中的单据只能由审批中心按当前节点的可编辑字段修改，业务端修改一律 409（PR #35 第二轮清单 1）。
  if (business.state === 'in_review' && !options.approvalEdit) {
    throw new AppError('CONFLICT', '审批中的申请只能由当前审批节点修改', { reason: 'APPROVAL_IN_PROGRESS' });
  }
  const before = business.payload;
  const normalized = normalizePatchedInput(ctx, before, patch);
  await assertNotBeforeCurrentCycle(tx, ctx, business.employeeId, normalized);
  await assertBusinessSequence(tx, ctx, business.employeeId, normalized);
  assertEmployTypeUsage(normalized);
  // 申请保持创建时所在的周期；改期落到别的周期须另起申请。
  const selected = NEW_CYCLE_KINDS.includes(normalized.kind)
    ? undefined
    : await selectEmploymentCycle(tx, ctx, business.employeeId, {
        effectiveDate: normalized.effectiveDate,
        expectedStaffId: before.selectedStaffId,
      });
  const prepared = await prepareEmploymentPatch(
    tx,
    ctx,
    { ...normalized, employeeId: business.employeeId, staffId: selected?.cycle.id },
    before,
  );
  const effective = await resolveEffectiveInheritance(tx, ctx, prepared, {
    staffId: selected?.cycle.id ?? '',
    predecessor: selected?.predecessor ?? null,
  });
  await validatePreparedEmployment(tx, ctx, business.employeeId, normalized.kind, prepared, effective.fields, business);
  await assertEstablishmentCapacity(tx, ctx, {
    businessId: id,
    employeeId: business.employeeId,
    kind: normalized.kind,
    effectiveDate: normalized.effectiveDate,
    fields: effective.fields,
    departmentId: effective.fields.departmentId,
    positionId: effective.fields.positionId,
  });
  await bumpEmploymentBusiness(tx, ctx, business);
  business.payload = await appendEmploymentPayload(
    tx,
    ctx,
    business.employeeId,
    id,
    business.revision,
    normalized,
    prepared,
    before.id,
    selected?.cycle.id,
    before.changeType ?? undefined,
  );
  await auditEmployment(
    tx,
    ctx,
    'employment.business.payload.append',
    'employment-business',
    id,
    payloadAudit(before),
    payloadAudit(business.payload),
  );
  return requireSavedBusiness(tx, ctx, id);
}

function normalizePatchedInput(
  ctx: EmploymentContext,
  before: EmploymentPayloadRow,
  patch: EmploymentBusinessPatch,
): NormalizedEmploymentInput {
  const fields: Partial<Record<keyof typeof before.fields, unknown>> = Object.fromEntries(
    before.explicitFieldCodes
      .filter((code) => code.startsWith('preset:'))
      .map((code) => {
        const field = code.slice('preset:'.length) as keyof typeof before.fields;
        return [field, before.fields[field]];
      }),
  );
  if (patch.fields && Object.hasOwn(patch.fields, 'departmentId') && !Object.hasOwn(patch.fields, 'directManagerId'))
    delete fields.directManagerId;
  // DEC-107：本次改选了职务而未传序列时，丢弃按旧职务带出（或旧填写）的序列，交由新职务重新带出。
  if (patch.fields && Object.hasOwn(patch.fields, 'postId') && !Object.hasOwn(patch.fields, 'sequenceId')) {
    delete fields.sequenceId;
  }
  const customFields = Object.fromEntries(
    before.explicitFieldCodes
      .filter((code) => code.startsWith('custom:'))
      .map((code) => [code.slice('custom:'.length), before.customFields[code.slice('custom:'.length)] ?? null]),
  );
  const lastWorkDate = patch.lastWorkDate === undefined ? before.lastWorkDate : patch.lastWorkDate;
  // 修改最后工作日时重新推导 D+1；客户端另填生效日仍由统一校验拒绝矛盾值。
  const effectiveDate = patch.effectiveDate ?? (patch.lastWorkDate === undefined ? before.effectiveDate : undefined);
  return normalizeEmploymentInput(ctx, {
    kind: before.kind,
    mode: before.mode,
    formId: before.formId,
    effectiveDate,
    lastWorkDate,
    fields: { ...fields, ...patch.fields },
    customFields: { ...customFields, ...patch.customFields },
  });
}

function assertEmployTypeUsage(input: Pick<NormalizedEmploymentInput, 'kind' | 'fields'>): void {
  if (!NEW_CYCLE_KINDS.includes(input.kind) && Object.prototype.hasOwnProperty.call(input.fields, 'employType')) {
    throw new AppError('VALIDATION_FAILED', '非入职类业务不能设置人员类别', { reason: 'EMPLOY_TYPE_NOT_ALLOWED' });
  }
}

/** 生效日当天及以前最后一条（同日取最后一次操作，DEC-108）决定本业务能否接在其后。 */
async function assertBusinessSequence(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: Pick<NormalizedEmploymentInput, 'kind' | 'effectiveDate'>,
  beforeOrder?: number,
): Promise<void> {
  // 落地时按实际插入点判断前一条（同日插到中间时不是当日最后一条，DEC-108）。
  const bound =
    beforeOrder === undefined
      ? sql`t.start_date <= ${input.effectiveDate}::date`
      : sql`(t.start_date, t.sort_order) < (${input.effectiveDate}::date, ${beforeOrder})`;
  const [latest] = rowsOf<{ kind: BusinessKind }>(
    await tx.execute(sql`
    SELECT r.kind FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${employeeId}::uuid AND ${bound}
    ORDER BY t.start_date DESC, t.sort_order DESC LIMIT 1
  `),
  );
  const reason = sequenceViolation(latest?.kind, input.kind);
  if (reason) throw new AppError('CONFLICT', '任职业务前后顺序不合法', { reason });
}

/** 前一条为 previous 时能否接 kind：终止任职后只能开新周期，在职时不能再入职（`07` §2、DEC-077）。 */
function sequenceViolation(previous: BusinessKind | undefined, kind: BusinessKind): string | undefined {
  const terminal = previous !== undefined && ['leave', 'retirement'].includes(previous);
  if (kind === 'hire' && previous && !terminal) return 'EMPLOYEE_ALREADY_EMPLOYED';
  if (kind === 'rehire' && previous !== 'leave') return 'REHIRE_REQUIRES_LEAVE';
  if (kind === 'retire_rehire' && previous !== 'retirement') return 'RETIRE_REHIRE_REQUIRES_RETIREMENT';
  if (!NEW_CYCLE_KINDS.includes(kind) && (!previous || terminal)) return 'ACTIVE_EMPLOYMENT_REQUIRED';
  return undefined;
}

/**
 * 插到当日中间时，原位置上的那条（随后后移）将以新记录为前一条，也须合法：例如离职申请插到同日直接调动之前
 * 会形成“离职 → 同周期调动”（PR #53 P2-R2-2）。不合法时整条拒绝，定时生效据此记生效失败（DEC-052）。
 */
async function assertSuccessorSequence(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  kind: BusinessKind,
  position: TimelinePosition,
): Promise<void> {
  if (!position.shifted) return;
  const [successor] = rowsOf<{ kind: BusinessKind }>(
    await tx.execute(sql`
    SELECT r.kind FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${employeeId}::uuid
      AND t.start_date=${position.date}::date AND t.sort_order=${position.order}
  `),
  );
  const reason = successor && sequenceViolation(kind, successor.kind);
  if (reason) {
    throw new AppError('CONFLICT', '任职业务前后顺序不合法', {
      reason: 'SUCCESSOR_SEQUENCE_INVALID',
      successor: reason,
    });
  }
}

async function assertDirectTransferAllowed(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: NormalizedEmploymentInput,
) {
  if (input.mode !== 'direct' || input.kind !== 'transfer') return;
  const settings = await readEmploymentSettings(tx, ctx.tenantId);
  if (!settings.allowDirectTransfer) {
    throw new AppError('CONFLICT', '本租户调动须走审批', { reason: 'DIRECT_TRANSFER_DISABLED' });
  }
  // DEC-154：调用方已锁员工，提交申请 / 审批 / 直接调动均在同一员工锁下复核最新状态（F-008）。
  const [pending] = rowsOf<{ state: string; effectiveDate: string }>(
    await tx.execute(sql`
      SELECT s.state,p.effective_date::text AS "effectiveDate" FROM employment_business_objects b
      JOIN LATERAL (SELECT kind, mode, effective_date FROM employment_payload_versions p
        WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
      JOIN LATERAL (SELECT state FROM employment_state_events s
        WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
      WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${employeeId}::uuid
        AND p.kind='transfer' AND p.mode='application' AND s.state IN ('in_review','approved')
      ORDER BY (s.state='in_review') DESC,p.effective_date LIMIT 1
    `),
  );
  if (pending?.state === 'approved')
    throw new AppError('CONFLICT', `当前存在未生效的调动记录（生效日期：${pending.effectiveDate}），无法进行此操作`, {
      reason: 'TRANSFER_APPROVED_PENDING',
    });
  if (pending) {
    throw new AppError('CONFLICT', '当前存在审批中的调动记录，无法进行此操作', {
      reason: 'TRANSFER_IN_REVIEW',
    });
  }
}

/**
 * 非入职类业务落在插入点前一条（同日取最后一次操作，DEC-108）所属的周期；不再接受客户端指定周期（DEC-111）。
 * expectedStaffId 是申请创建时解析出的周期：改期或生效时若已落到别的周期则拒绝，不跨周期落地。
 */
export async function selectEmploymentCycle(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: { effectiveDate: string; expectedStaffId?: string | null; beforeOrder?: number },
): Promise<SelectedEmploymentCycle> {
  const previous = await findPredecessor(tx, ctx.tenantId, employeeId, input.effectiveDate, input.beforeOrder);
  if (!previous) throw new AppError('VALIDATION_FAILED', '员工尚无可用于此业务的任职周期');
  if (input.expectedStaffId && previous.staffId !== input.expectedStaffId) {
    throw new AppError('CONFLICT', '任职业务前后顺序不合法', { reason: 'EMPLOYMENT_CYCLE_MISMATCH' });
  }
  const [cycle] = rowsOf<EmploymentCycleRow>(
    await tx.execute(sql`
      SELECT id, entry_date::text AS "entryDate", entry_type AS "entryType", employ_type AS "employType"
      FROM employment_cycles
      WHERE tenant_id = ${ctx.tenantId} AND employee_id = ${employeeId}::uuid
        AND id = ${previous.staffId}::uuid LIMIT 1
    `),
  );
  if (!cycle) throw new AppError('SERVICE_UNAVAILABLE', '任职周期不可用');
  return { cycle, predecessor: previous };
}

export async function appendEmploymentPayload(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  businessId: string,
  versionNo: number,
  input: NormalizedEmploymentInput,
  prepared: PreparedInheritance,
  previousVersionId: string | null,
  selectedStaffId?: string,
  changeType?: ChangeType,
): Promise<EmploymentPayloadRow> {
  const payload: EmploymentPayloadRow = {
    ...prepared,
    id: randomUUID(),
    tenantId: ctx.tenantId,
    employeeId,
    businessId,
    versionNo,
    previousVersionId,
    kind: input.kind,
    changeType: changeType ?? null,
    mode: input.mode,
    effectiveDate: input.effectiveDate,
    lastWorkDate: input.lastWorkDate,
    formId: input.formId,
    selectedStaffId: selectedStaffId ?? null,
  };
  const { fields, ...metadata } = payload;
  await insertEmploymentRow(tx, 'employment_payload_versions', {
    ...fields,
    ...metadata,
    createdAt: ctx.now.toISOString(),
  });
  return payload;
}

export async function appendEmploymentState(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  state: EmploymentBusiness['status'],
): Promise<void> {
  const before = business.eventNo ? business.state : null;
  await insertEmploymentRow(tx, 'employment_state_events', {
    id: randomUUID(),
    tenantId: ctx.tenantId,
    employeeId: business.employeeId,
    businessId: business.id,
    payloadVersionId: business.payload.id,
    state,
    eventNo: business.eventNo + 1,
    commandId: ctx.commandId,
    createdAt: ctx.now.toISOString(),
  });
  business.state = state;
  business.eventNo += 1;
  await auditEmployment(
    tx,
    ctx,
    `employment.business.state.${state}`,
    'employment-business',
    business.id,
    { state: before },
    { state },
  );
}

async function cycleForMaterialization(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  newCycle: boolean,
  position: TimelinePosition,
): Promise<SelectedEmploymentCycle | undefined> {
  if (newCycle) return undefined;
  return selectEmploymentCycle(tx, ctx, business.employeeId, {
    effectiveDate: business.payload.effectiveDate,
    expectedStaffId: business.payload.selectedStaffId,
    beforeOrder: position.order,
  });
}

export async function materializeEmploymentRecord(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  options: { forwardUpdate?: boolean; establishmentWarnings?: EstablishmentWarning[]; scheduledDate?: string } = {},
): Promise<void> {
  const payload = business.payload;
  // DEC-108：按操作先后定插入点；先提交、后落地的申请可能插在当日已有记录之前，前驱与顺序校验都以插入点为准。
  const position = await timelinePosition(tx, ctx, business.employeeId, payload.effectiveDate, business.id);
  await assertNotBeforeCurrentCycle(tx, ctx, business.employeeId, payload);
  await assertBusinessSequence(tx, ctx, business.employeeId, payload, position.order);
  await assertSuccessorSequence(tx, ctx, business.employeeId, payload.kind, position);
  const newCycle = NEW_CYCLE_KINDS.includes(payload.kind);
  const selected = await cycleForMaterialization(tx, ctx, business, newCycle, position);
  const staffId = selected?.cycle.id ?? randomUUID();
  const entryDate = selected?.cycle.entryDate ?? payload.effectiveDate;
  const inherited = await resolveEffectiveInheritance(tx, ctx, payload, {
    staffId,
    predecessor: selected?.predecessor ?? null,
  });
  const employType = effectiveEmployType(payload, selected);
  const fields = { ...inherited.fields, employType, jobNumber: business.employee.code };
  await requireScopedEmploymentObject(tx, ctx, business.employeeId, fields.departmentId);
  const { next } = await employmentTimelineNeighbors(tx, ctx, business.employeeId, payload.effectiveDate, business.id);
  // 申请到生效日落地时按实际插入位置（DEC-108）与当日的汇报链再判一次循环汇报（审批期间他人的任职可能已变）；
  // 插在当日操作更晚的记录之前时区间为空，经理当天就被取代，不校验。
  const reporting =
    fields.directManagerId !== null
      ? { employeeId: business.employeeId, window: windowBefore(payload.effectiveDate, next) }
      : undefined;
  // DEC-161：审批通过后仍可能新增停用排期，落地前按 DEC-150 重查整个时段。
  // 拒绝后由生效端口记失败与 HR 待办、按 DEC-112 挂起后序；不能截断任职或改期绕过。
  await validateNewEmploymentReferences(tx, ctx, fields, payload.effectiveDate, reporting);
  assertRequiredTransferFields(payload.kind, payload.formSnapshot, fields);
  await checkMaterializedCapacity(tx, ctx, business, fields, options.establishmentWarnings);
  if (newCycle) await insertNewEmploymentCycle(tx, ctx, business, { staffId, entryDate, employType });
  await insertEmploymentRow(tx, 'employment_records', {
    ...fields,
    id: business.id,
    tenantId: ctx.tenantId,
    employeeId: business.employeeId,
    payloadVersionId: payload.id,
    staffId,
    entryDate,
    kind: payload.kind,
    changeType: payload.changeType ?? null,
    startDate: payload.effectiveDate,
    lastWorkDate: payload.lastWorkDate,
    serviceType: 'primary',
    isInserted: !!next,
    inheritanceSourceId: selected?.predecessor?.staffId === staffId ? selected.predecessor.id : null,
    customFields: inherited.customFields,
    createdAt: ctx.now.toISOString(),
  });
  await insertEmploymentTimeline(tx, ctx, business.employeeId, business.id, staffId, payload.effectiveDate);
  await auditMaterialization(
    tx,
    ctx,
    business,
    selected?.predecessor ?? null,
    fields,
    inherited.customFields,
    staffId,
    entryDate,
  );
  if (options.forwardUpdate !== false) {
    await forwardMaterializedRecord(
      tx,
      ctx,
      business,
      staffId,
      selected?.predecessor ?? null,
      {
        fields,
        customFields: inherited.customFields,
      },
      options,
    );
  }
  await queueTransferLinkage(tx, ctx, business.id, payload.kind, fields, payload.effectiveDate);
  await registerCompletion(tx, ctx, business, fields);
  await personnelHooks.sync(tx, ctx, business.employeeId, business.id, payload.kind, payload.effectiveDate);
}

function effectiveEmployType(payload: EmploymentPayloadRow, selected?: SelectedEmploymentCycle): EmployType {
  if (payload.kind === 'intern_regularization') return 'internal';
  if (NEW_CYCLE_KINDS.includes(payload.kind)) return payload.fields.employType ?? 'internal';
  const sameCycle = selected?.predecessor?.staffId === selected?.cycle.id;
  return (sameCycle ? selected?.predecessor?.fields.employType : null) ?? selected?.cycle.employType ?? 'internal';
}

function customAudit(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [`custom:${key}`, value]));
}

function payloadAudit(payload: EmploymentPayloadRow): Record<string, unknown> {
  return {
    ...payload.fields,
    ...customAudit(payload.customFields),
    kind: payload.kind,
    effectiveDate: payload.effectiveDate,
  };
}

export async function requireSavedBusiness(tx: Tx, ctx: EmploymentContext, id: string): Promise<EmploymentBusiness> {
  const saved = await loadEmploymentBusiness(tx, ctx.tenantId, id, tenantLocalDate(ctx.now, ctx.timezone));
  if (!saved) throw new AppError('SERVICE_UNAVAILABLE', '任职业务保存结果不可用');
  return saved;
}

async function forwardMaterializedRecord(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  staffId: string,
  predecessor: EmploymentRecord | null,
  after: ForwardValues,
  options: { establishmentWarnings?: EstablishmentWarning[]; scheduledDate?: string } = {},
) {
  await forwardUpdateEmployment(tx, ctx, {
    ...options,
    employeeId: business.employeeId,
    businessId: business.id,
    staffId,
    effectiveDate: business.payload.effectiveDate,
    before: predecessor?.staffId === staffId ? predecessor : { fields: emptyPresetFields(), customFields: {} },
    after,
  });
}

async function insertNewEmploymentCycle(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  cycle: { staffId: string; entryDate: string; employType: EmployType },
) {
  await insertEmploymentRow(tx, 'employment_cycles', {
    id: cycle.staffId,
    tenantId: ctx.tenantId,
    employeeId: business.employeeId,
    entryDate: cycle.entryDate,
    entryType: business.payload.kind,
    employType: cycle.employType,
    createdAt: ctx.now.toISOString(),
  });
}

async function checkMaterializedCapacity(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  fields: PresetFields,
  warnings?: EstablishmentWarning[],
) {
  await assertEstablishmentCapacity(
    tx,
    ctx,
    {
      businessId: business.id,
      employeeId: business.employeeId,
      kind: business.payload.kind,
      effectiveDate: business.payload.effectiveDate,
      fields,
      departmentId: fields.departmentId,
      positionId: fields.positionId,
    },
    warnings,
  );
}

async function validatePreparedEmployment(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  kind: BusinessKind,
  prepared: PreparedInheritance,
  effectiveFields: PresetFields,
  existing?: LockedEmploymentBusiness,
) {
  assertRequiredTransferFields(kind, prepared.formSnapshot, { ...effectiveFields });
  if (kind === 'transfer')
    await validateTransferSubordinates(tx, ctx, employeeId, effectiveFields, prepared.effectiveDate);
  await requireScopedEmploymentObject(tx, ctx, employeeId, prepared.fields.departmentId, existing?.id);
  // DEC-108 / PR #54：审批中编辑保留原提交操作顺序；草稿/驳回单重提时排在同日最后。
  const reporting = await newRecordReporting(
    tx,
    ctx,
    employeeId,
    effectiveFields.directManagerId ? ['preset:directManagerId'] : prepared.explicitFieldCodes,
    prepared.effectiveDate,
    existing?.state === 'in_review' ? existing.id : undefined,
  );
  await validateNewEmploymentReferences(tx, ctx, prepared.fields, prepared.effectiveDate, reporting);
}

async function registerCompletion(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  fields: PresetFields,
) {
  if (business.payload.kind === 'transfer')
    for (const field of clearedTransferFields(business.payload.formSnapshot, { ...fields }))
      await openCompletion(
        tx,
        ctx,
        business.employeeId,
        business.id,
        `preset:${field}`,
        business.payload.effectiveDate,
      );
  await reconcileCompletion(tx, ctx, business.employeeId);
}

async function auditMaterialization(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  predecessor: EmploymentRecord | null,
  fields: PresetFields,
  customFields: Readonly<Record<string, unknown>>,
  staffId: string,
  entryDate: string,
) {
  const payload = business.payload;
  await auditEmployment(
    tx,
    ctx,
    'employment.record.create',
    'employment-record',
    business.id,
    predecessor ? { ...predecessor.fields, ...customAudit(predecessor.customFields) } : null,
    {
      ...fields,
      ...customAudit(customFields),
      staffId,
      entryDate,
      effectiveDate: payload.effectiveDate,
    },
    undefined,
    payload.kind === 'transfer'
      ? {
          clearedFieldCodes: clearedTransferFields(payload.formSnapshot, { ...fields }).map(
            (field) => `preset:${field}`,
          ),
        }
      : undefined,
  );
}
