import { personnelHooks } from './personnel-hooks.js';
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
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
import { validateEmploymentReferences } from './references.js';
import { employmentTimelineNeighbors, insertEmploymentTimeline } from './timeline.js';
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
}

export async function createEmploymentBusiness(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: EmploymentBusinessInput,
  options: CreateEmploymentOptions = {},
): Promise<EmploymentBusiness> {
  const normalized = normalizeEmploymentInput(ctx, input);
  const employee = await lockEmploymentEmployee(tx, ctx, employeeId, ctx.expectedRevision);
  await assertNotBeforeCurrentCycle(tx, ctx, employee.id, normalized);
  await assertBusinessSequence(tx, ctx, employee.id, normalized);
  assertEmployTypeUsage(normalized);
  await assertDirectTransferAllowed(tx, ctx, normalized);
  const selected = NEW_CYCLE_KINDS.includes(normalized.kind)
    ? undefined
    : await selectEmploymentCycle(tx, ctx, employee.id, normalized);
  const prepared = await prepareInheritance(tx, ctx, {
    ...normalized,
    employeeId: employee.id,
    staffId: selected?.cycle.id,
  });
  await requireScopedEmploymentObject(tx, ctx, employee.id, prepared.fields.departmentId);
  await validateEmploymentReferences(tx, ctx, prepared.fields, normalized.effectiveDate);
  const id = randomUUID();
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
  await requireScopedEmploymentObject(tx, ctx, business.employeeId, prepared.fields.departmentId, business.id);
  await validateEmploymentReferences(tx, ctx, prepared.fields, normalized.effectiveDate);
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
): Promise<void> {
  const [latest] = rowsOf<{ kind: BusinessKind }>(
    await tx.execute(sql`
    SELECT r.kind FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${employeeId}::uuid
      AND t.start_date <= ${input.effectiveDate}::date
    ORDER BY t.start_date DESC, t.sort_order DESC LIMIT 1
  `),
  );
  const terminal = latest && ['leave', 'retirement'].includes(latest.kind);
  let reason: string | undefined;
  if (input.kind === 'hire' && latest && !terminal) reason = 'EMPLOYEE_ALREADY_EMPLOYED';
  else if (input.kind === 'rehire' && latest?.kind !== 'leave') reason = 'REHIRE_REQUIRES_LEAVE';
  else if (input.kind === 'retire_rehire' && latest?.kind !== 'retirement')
    reason = 'RETIRE_REHIRE_REQUIRES_RETIREMENT';
  else if (!NEW_CYCLE_KINDS.includes(input.kind) && (!latest || terminal)) reason = 'ACTIVE_EMPLOYMENT_REQUIRED';
  if (reason) throw new AppError('CONFLICT', '任职业务前后顺序不合法', { reason });
}

async function assertDirectTransferAllowed(tx: Tx, ctx: EmploymentContext, input: NormalizedEmploymentInput) {
  if (input.mode !== 'direct' || input.kind !== 'transfer') return;
  const settings = await readEmploymentSettings(tx, ctx.tenantId);
  if (!settings.allowDirectTransfer) {
    throw new AppError('CONFLICT', '租户已关闭允许直接调动', { reason: 'DIRECT_TRANSFER_DISABLED' });
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
  input: { effectiveDate: string; expectedStaffId?: string | null },
): Promise<SelectedEmploymentCycle> {
  const previous = await findPredecessor(tx, ctx.tenantId, employeeId, input.effectiveDate);
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
): Promise<SelectedEmploymentCycle | undefined> {
  if (newCycle) return undefined;
  return selectEmploymentCycle(tx, ctx, business.employeeId, {
    effectiveDate: business.payload.effectiveDate,
    expectedStaffId: business.payload.selectedStaffId,
  });
}

export async function materializeEmploymentRecord(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  options: { forwardUpdate?: boolean } = {},
): Promise<void> {
  const payload = business.payload;
  await assertNotBeforeCurrentCycle(tx, ctx, business.employeeId, payload);
  await assertBusinessSequence(tx, ctx, business.employeeId, payload);
  const newCycle = NEW_CYCLE_KINDS.includes(payload.kind);
  const selected = await cycleForMaterialization(tx, ctx, business, newCycle);
  const staffId = selected?.cycle.id ?? randomUUID();
  const entryDate = selected?.cycle.entryDate ?? payload.effectiveDate;
  const inherited = await resolveEffectiveInheritance(tx, ctx, payload, {
    staffId,
    predecessor: selected?.predecessor ?? null,
  });
  const employType = effectiveEmployType(payload, selected);
  const fields = { ...inherited.fields, employType, jobNumber: business.employee.code };
  await requireScopedEmploymentObject(tx, ctx, business.employeeId, fields.departmentId);
  await validateEmploymentReferences(tx, ctx, fields, payload.effectiveDate);
  const { next } = await employmentTimelineNeighbors(tx, ctx, business.employeeId, payload.effectiveDate);
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
  await auditEmployment(
    tx,
    ctx,
    'employment.record.create',
    'employment-record',
    business.id,
    selected?.predecessor
      ? { ...selected.predecessor.fields, ...customAudit(selected.predecessor.customFields) }
      : null,
    { ...fields, ...customAudit(inherited.customFields), staffId, entryDate, effectiveDate: payload.effectiveDate },
  );
  if (options.forwardUpdate !== false) {
    await forwardMaterializedRecord(tx, ctx, business, staffId, selected?.predecessor ?? null, {
      fields,
      customFields: inherited.customFields,
    });
  }
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
) {
  await forwardUpdateEmployment(tx, ctx, {
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
