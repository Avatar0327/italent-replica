import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { camelRow, rowsOf, snapshotFields, type EmploymentPayloadRow } from '../employment/record-store.js';
import { normalizePatchedInput } from '../employment/write-service.js';
import type { EmploymentBusinessPatch, EmploymentContext } from '../employment/types.js';
import { requireManagerReferenceValues } from './manager-references.js';

/** 与实际 PATCH 使用同一显式字段合并规则；冻结表单中的只读继承值不变成待校验输入。 */
export async function requireManagerBusinessReferences(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  patch: EmploymentBusinessPatch,
) {
  const [raw] = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      SELECT * FROM employment_payload_versions
      WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid
      ORDER BY version_no DESC LIMIT 1
    `),
  );
  if (!raw) throw new AppError('NOT_FOUND', '任职业务不存在');
  const row = camelRow(raw);
  const payload = { ...row, fields: snapshotFields(row) } as unknown as EmploymentPayloadRow;
  const input = normalizePatchedInput(ctx, payload, patch);
  await requireManagerReferenceValues(tx, ctx, input.effectiveDate, input.fields);
}
