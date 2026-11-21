import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { auditEmployment } from './context.js';
import { changedDerivationKeys, derivationFields, type DerivationRule } from './field-derivations.js';
import { loadDerivationAnchors, type FieldOriginDraft } from './field-origin-store.js';
import { appendPayloadFieldOrigins } from './field-origin-write.js';
import { insertEmploymentRow, rowsOf, type EmploymentPayloadRow } from './record-store.js';
import type { ForwardFieldChange, ForwardValues } from './forward-rules.js';
import type { EmploymentContext, PresetFields } from './types.js';

export function forwardFieldCode(field: string): string {
  return field.startsWith('custom:') ? field : `preset:${field}`;
}

export function systemForwardOrigins(
  changes: readonly ForwardFieldChange[],
  reason: string,
  sourceBusinessId?: string,
) {
  // 兼职机构是随部门切换更新的载荷元数据，没有对应任职字段编码。
  return changes
    .filter(({ field, before, after }) => field !== 'institutionId' && before !== after)
    .map(({ field, after }): FieldOriginDraft => ({
      fieldCode: forwardFieldCode(field),
      originKind: 'system-input',
      value: after,
      sourceBusinessId,
      reason,
    }));
}

/** 已生效目标以最终快照为起点；待生效目标保留其它 deferred 字段，已同步字段不再重算。 */
export async function appendForwardPayload(
  tx: Tx,
  ctx: EmploymentContext,
  payload: EmploymentPayloadRow,
  values: ForwardValues,
  triggerBusinessId: string,
  isRecordSnapshot: boolean,
  changes: readonly ForwardFieldChange[],
  origins: readonly FieldOriginDraft[],
): Promise<EmploymentPayloadRow> {
  const codes = changes.map(({ field }) => forwardFieldCode(field));
  const next: EmploymentPayloadRow = {
    ...payload,
    ...values,
    id: randomUUID(),
    versionNo: payload.versionNo + 1,
    previousVersionId: payload.id,
    commandId: ctx.commandId,
    triggerBusinessId,
    isRecordSnapshot,
    deferredFieldCodes: isRecordSnapshot ? [] : payload.deferredFieldCodes.filter((code) => !codes.includes(code)),
    explicitFieldCodes: [...new Set([...payload.explicitFieldCodes, ...codes])],
  };
  const { fields, ...metadata } = next;
  await insertEmploymentRow(tx, 'employment_payload_versions', {
    ...metadata,
    ...fields,
    createdAt: ctx.now.toISOString(),
  });
  await appendPayloadFieldOrigins(tx, ctx, next, isRecordSnapshot ? next.businessId : undefined, origins);
  return next;
}

async function latestForwardSourceVersion(tx: Tx, ctx: EmploymentContext, businessId: string | null) {
  // 锁内固定本次传播的来源版本；来源后来的人工编辑或同步不应倒灌这次传播。
  const [source] = rowsOf<{ id: string; versionNo: number }>(
    await tx.execute(sql`SELECT id, version_no AS "versionNo" FROM employment_payload_versions
      WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid
      ORDER BY version_no DESC LIMIT 1`),
  );
  return source;
}

export async function loadForwardSource(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  before: PresetFields,
  after: PresetFields,
) {
  const version = await latestForwardSourceVersion(tx, ctx, businessId);
  if (!version) throw new TypeError('向后更新的来源载荷不存在');
  const keys = changedDerivationKeys(before, after);
  const anchors = await loadDerivationAnchors(tx, ctx, businessId, keys);
  const derivations = anchors.flatMap(({ payloadVersionId, originKind, derivationRule, referenceId, value }) =>
    payloadVersionId === version.id && (originKind === 'derive' || originKind === 'derive-edit') && referenceId
      ? [{ rule: derivationRule as DerivationRule, referenceId, value }]
      : [],
  );
  return { businessId, versionNo: version.versionNo, derivations };
}

export function forwardTargetOrigins(
  source: Awaited<ReturnType<typeof loadForwardSource>>,
  changes: readonly ForwardFieldChange[],
): FieldOriginDraft[] {
  const origins = changes.map(({ field, before, after }): FieldOriginDraft => ({
    fieldCode: forwardFieldCode(field),
    originKind: 'forward-update',
    value: after,
    sourceBusinessId: source.businessId,
    sourceVersionNo: source.versionNo,
    matchBefore: before,
  }));
  // §4.4.2 #6：引用和派生值均实际随本次传播替换，才在目标登记连带派生。
  // 派生沿用本次来源算出的值，保留逐字段匹配结果及其旧值。
  const replaced = new Map(changes.map(({ field, after }) => [field, after]));
  for (const { rule, referenceId, value } of source.derivations) {
    const { field, reference } = derivationFields({ rule, referenceId });
    if (replaced.get(reference) !== referenceId || replaced.get(field) !== value) continue;
    origins.push({
      fieldCode: forwardFieldCode(field),
      originKind: 'derive-edit',
      value,
      derivationRule: rule,
      referenceId,
      sourceBusinessId: source.businessId,
      sourceVersionNo: source.versionNo,
    });
  }
  return origins;
}

export async function auditForwardTarget(
  tx: Tx,
  ctx: EmploymentContext,
  next: EmploymentPayloadRow,
  changes: readonly ForwardFieldChange[],
  sourceVersionNo?: number,
): Promise<void> {
  sourceVersionNo ??= (await latestForwardSourceVersion(tx, ctx, next.triggerBusinessId ?? null))?.versionNo;
  await tx.execute(sql`
    UPDATE employment_business_objects SET revision=revision+1
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${next.employeeId}::uuid AND id=${next.businessId}::uuid
  `);
  await auditEmployment(
    tx,
    ctx,
    'employment.forward-update',
    next.isRecordSnapshot ? 'employment-record' : 'employment-business',
    next.businessId,
    Object.fromEntries(changes.map((change) => [change.field, change.before])),
    Object.fromEntries(changes.map((change) => [change.field, change.after])),
    next.id,
    { sourceVersionNo: sourceVersionNo ?? null },
  );
}
