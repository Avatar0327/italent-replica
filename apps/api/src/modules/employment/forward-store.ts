import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { auditEmployment } from './context.js';
import { insertEmploymentRow, rowsOf, type EmploymentPayloadRow } from './record-store.js';
import type { ForwardFieldChange, ForwardValues } from './forward-rules.js';
import type { EmploymentContext } from './types.js';

/** 已生效目标以最终快照为起点；待生效目标保留其它 deferred 字段，已同步字段不再重算。 */
export async function appendForwardPayload(
  tx: Tx,
  ctx: EmploymentContext,
  payload: EmploymentPayloadRow,
  values: ForwardValues,
  triggerBusinessId: string,
  isRecordSnapshot: boolean,
  changes: readonly ForwardFieldChange[],
): Promise<EmploymentPayloadRow> {
  const codes = changes.map((change) => (change.field.startsWith('custom:') ? change.field : `preset:${change.field}`));
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
  return next;
}

export async function auditForwardTarget(
  tx: Tx,
  ctx: EmploymentContext,
  next: EmploymentPayloadRow,
  changes: readonly ForwardFieldChange[],
): Promise<void> {
  // 锁内固定本次传播的来源版本；来源后来的人工编辑或同步不应倒灌这次传播。
  const [source] = rowsOf<{ versionNo: number }>(
    await tx.execute(sql`SELECT version_no AS "versionNo" FROM employment_payload_versions
      WHERE tenant_id=${ctx.tenantId} AND business_id=${next.triggerBusinessId ?? null}::uuid
      ORDER BY version_no DESC LIMIT 1`),
  );
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
    { sourceVersionNo: source?.versionNo ?? null },
  );
}
