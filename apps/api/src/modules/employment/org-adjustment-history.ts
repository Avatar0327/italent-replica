/** DEC-186 / 195：载荷只追加，重建时按来源当前时间线和自动同步依赖判定可重放历史。 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { camelRow, rowsOf, snapshotFields, type EmploymentPayloadRow } from './record-store.js';
import type { EmploymentContext, EmploymentRecord } from './types.js';

export interface AdjustmentHistory {
  readonly payload: EmploymentPayloadRow;
  readonly replay: boolean;
  readonly sequenceSource: { sourceKind: 'posts' | 'positions'; sourceId: string } | null;
}

export async function orgAdjustmentHistory(tx: Tx, ctx: EmploymentContext, record: EmploymentRecord) {
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
    SELECT p.*,NOT EXISTS (SELECT 1 FROM employment_outbox o
        WHERE o.tenant_id=p.tenant_id AND o.payload_version_id=p.id
          AND o.event_type='employment.org-adjustment.rebased')
      AND (p.trigger_business_id IS NULL OR p.trigger_business_id=p.business_id OR EXISTS (
        SELECT 1 FROM employment_timeline source JOIN employment_timeline target
          ON target.tenant_id=source.tenant_id AND target.record_id=p.business_id
        WHERE source.tenant_id=p.tenant_id AND source.record_id=p.trigger_business_id
          AND source.employee_id=target.employee_id AND source.staff_id=target.staff_id
          AND (source.start_date,source.sort_order)<(target.start_date,target.sort_order))) AS replay,
      (SELECT o.payload->'meta' FROM employment_outbox o
        WHERE o.tenant_id=p.tenant_id AND o.payload_version_id=p.id
          AND o.event_type='employment.sequence-sync' LIMIT 1) AS sequence_source
    FROM employment_payload_versions p WHERE p.tenant_id=${ctx.tenantId} AND p.business_id=${record.id}::uuid
    ORDER BY p.version_no LIMIT 1001`),
  );
  if (rows.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '组织调整载荷历史超过处理上限');
  return rows.map((row): AdjustmentHistory => {
    const { replay, sequenceSource, ...raw } = camelRow(row);
    return {
      replay: Boolean(replay),
      sequenceSource: sequenceSource as AdjustmentHistory['sequenceSource'],
      payload: { ...raw, fields: snapshotFields(raw) } as unknown as EmploymentPayloadRow,
    };
  });
}
