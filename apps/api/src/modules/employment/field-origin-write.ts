import { sql, type Tx } from '@italent/db';
import { FORM_DEPENDENCY_RESET, changedInputFields, requestInputFields, type FieldOriginInput } from '@italent/domain';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { derivationFields } from './field-derivations.js';
import { appendFieldOrigins, loadFieldOrigins, type FieldOriginDraft } from './field-origin-store.js';
import type { PreparedFormInheritance } from './inheritance.js';
import { rowsOf, type EmploymentPayloadRow } from './record-store.js';
import type { EmploymentContext, EmploymentRecord, NormalizedEmploymentInput, PresetFields } from './types.js';

interface OriginActorOptions {
  readonly approvalEdit?: boolean;
  readonly systemInput?: boolean;
}

export function originActorKind(
  ctx: Pick<EmploymentContext, 'userId' | 'systemProxy'>,
  business: { readonly employeeId: string; readonly selfServiceEmployeeId?: string },
  options: OriginActorOptions,
) {
  if (options.approvalEdit) return 'approval-edit';
  if (ctx.userId === SYSTEM_USER_ID || ctx.systemProxy || options.systemInput) return 'system-input';
  return business.employeeId === business.selfServiceEmployeeId ? 'employee-input' : 'hr-input';
}

export async function fieldOriginEditor(
  tx: Tx,
  ctx: EmploymentContext,
  before: EmploymentPayloadRow,
  options: OriginActorOptions,
) {
  // 审批编辑优先；保存后的自助单据同时核对发起类型和此刻的本人绑定。
  const [self] =
    options.approvalEdit || before.kind !== 'transfer'
      ? []
      : rowsOf<{ employeeId: string }>(
          await tx.execute(sql`
      SELECT r.employee_id AS "employeeId" FROM transfer_requests r
      JOIN permission_user_person_links l ON l.tenant_id = r.tenant_id AND l.employee_id = r.employee_id
      WHERE r.tenant_id = ${ctx.tenantId} AND r.business_id = ${before.businessId}
        AND r.initiator = 'employee' AND l.user_id = ${ctx.userId}
    `),
        );
  return originActorKind(ctx, { employeeId: before.employeeId, selfServiceEmployeeId: self?.employeeId }, options);
}

interface FormOriginInput {
  readonly request?: FieldOriginInput & { lastWorkDate?: string | null };
  readonly businessId: string;
  readonly actor: ReturnType<typeof originActorKind>;
  readonly before?: EmploymentPayloadRow;
}

export function formFieldOrigins(
  prepared: PreparedFormInheritance,
  normalized: NormalizedEmploymentInput,
  options: FormOriginInput,
): FieldOriginDraft[] {
  const { request = normalized, before, actor, businessId } = options;
  const changed = before ? changedInputFields(before, prepared) : new Set<string>();
  // F-036 §4.4.1、DEC-977：整版重提带上的同值字段沿用已有来源。
  const entered = before ? changedInputFields(before, request) : requestInputFields(request);
  const byField = new Map<string, FieldOriginDraft>();
  for (const origin of prepared.formSnapshot.fieldDerivations ?? []) {
    const field = derivationFields(origin).field;
    const fieldCode = `preset:${field}`;
    const previousRule = before?.formSnapshot.fieldDerivations?.find(
      (previous) => previous.rule === origin.rule && previous.referenceId === origin.referenceId,
    );
    if (previousRule && !changed.has(fieldCode)) continue;
    byField.set(fieldCode, {
      fieldCode,
      originKind: 'derive',
      value: prepared.fields[field],
      derivationRule: origin.rule,
      referenceId: origin.referenceId,
    });
  }
  const sourceBusinessId = normalized.kind === 'org_adjustment' && actor === 'system-input' ? businessId : undefined;
  for (const fieldCode of entered) {
    if (byField.has(fieldCode) || (before && !changed.has(fieldCode))) continue;
    const value = fieldCode.startsWith('custom:')
      ? prepared.customFields[fieldCode.slice('custom:'.length)]
      : prepared.fields[fieldCode.slice('preset:'.length) as keyof typeof prepared.fields];
    if (value !== undefined) byField.set(fieldCode, { fieldCode, originKind: actor, value, sourceBusinessId });
  }
  if (request.lastWorkDate !== undefined && normalized.lastWorkDate !== (before?.lastWorkDate ?? null))
    byField.set('preset:lastWorkDate', {
      fieldCode: 'preset:lastWorkDate',
      originKind: actor,
      value: normalized.lastWorkDate,
    });

  const reprocess = !before || before.effectiveDate !== prepared.effectiveDate || changed.has('preset:departmentId');
  const policies = prepared.originPolicies.filter(
    ({ fieldCode }) => reprocess || (changed.has(fieldCode) && !byField.has(fieldCode)),
  );
  return [...policies, ...byField.values()];
}

export function discardedFormFields(fields: Partial<PresetFields> | undefined) {
  const discarded: ('directManagerId' | 'sequenceId')[] = [];
  if (!fields) return discarded;
  if (Object.hasOwn(fields, 'departmentId') && !Object.hasOwn(fields, 'directManagerId'))
    discarded.push('directManagerId');
  // DEC-107：交由新职务重新带出序列。
  if (Object.hasOwn(fields, 'postId') && !Object.hasOwn(fields, 'sequenceId')) discarded.push('sequenceId');
  return discarded;
}

export async function endDiscardedFormOverrides(
  tx: Tx,
  ctx: EmploymentContext,
  before: EmploymentPayloadRow,
  prepared: PreparedFormInheritance,
  discarded: ReturnType<typeof discardedFormFields>,
  origins: FieldOriginDraft[],
) {
  const fields = new Map(discarded.map((field) => [`preset:${field}`, field]));
  for (const { fieldCode, originKind } of origins) if (originKind === 'derive') fields.delete(fieldCode);
  for (const fieldCode of prepared.explicitFieldCodes) fields.delete(fieldCode);
  if (!fields.size) return origins;
  const states = await loadFieldOrigins(tx, ctx, before.businessId, [...fields.keys()]);
  const changed = changedInputFields(before, prepared);
  for (const [fieldCode, field] of fields) {
    const override = states.get(fieldCode)?.override;
    if (!override && !before.explicitFieldCodes.includes(fieldCode)) continue;
    const dependency = field === 'sequenceId' ? 'postId' : 'departmentId';
    // 同一引用带出的值沿用原派生来源；整版重提时可能再次带上引用。
    if (override?.originKind === 'derive' && !changed.has(`preset:${dependency}`)) continue;
    const policy = prepared.originPolicies.find((row) => row.fieldCode === fieldCode);
    const index = origins.findIndex((row) => row.fieldCode === fieldCode);
    if (index >= 0) origins.splice(index, 1);
    // DEC-976：放弃旧依赖时，旧填写结束；此处的空值不同于仍会到期解析的延迟字段。
    origins.push(
      prepared.fields[field] == null && policy?.originKind !== 'deferred'
        ? { fieldCode, originKind: 'none', value: null }
        : (policy ?? { fieldCode, originKind: 'none', value: null }),
    );
    if (override)
      origins.push({ fieldCode, originKind: 'fallback', refSeq: override.seq, reason: FORM_DEPENDENCY_RESET });
  }
  return origins;
}

export function exitPlanOrigins(
  before: Pick<EmploymentPayloadRow, 'effectiveDate' | 'lastWorkDate'>,
  after: Pick<EmploymentPayloadRow, 'effectiveDate' | 'lastWorkDate'>,
): FieldOriginDraft[] {
  return (['effectiveDate', 'lastWorkDate'] as const).flatMap((field) =>
    before[field] === after[field]
      ? []
      : [{ fieldCode: `preset:${field}`, originKind: 'hr-input', value: after[field] }],
  );
}

export function copyFieldOrigins(previous: EmploymentRecord): FieldOriginDraft[] {
  return [
    ...Object.entries(previous.fields).map(([field, value]) => [`preset:${field}`, value] as const),
    ...Object.entries(previous.customFields).map(([id, value]) => [`custom:${id}`, value] as const),
  ].map(([fieldCode, value]) => ({
    fieldCode,
    value,
    originKind: 'copy',
    sourceRecordId: previous.id,
    sourceBusinessId: previous.id,
  }));
}

export function appendPayloadFieldOrigins(
  tx: Tx,
  ctx: EmploymentContext,
  payload: Pick<EmploymentPayloadRow, 'id' | 'employeeId' | 'businessId'>,
  recordId: string | undefined,
  origins: readonly FieldOriginDraft[],
) {
  const { id: payloadVersionId, employeeId, businessId } = payload;
  return appendFieldOrigins(
    tx,
    ctx,
    origins.map((row) => ({ ...row, payloadVersionId, employeeId, businessId, recordId })),
  );
}
