/** DEC-127：按引用找当前 / 未来任职；不使用值匹配向后更新。 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { requireEmploymentWrite, requireLinkedEmploymentRecord } from '../employment/context.js';
import { loadEmploymentRecord } from '../employment/read-model.js';
import { camelRow, rowsOf, snapshotFields, type EmploymentPayloadRow } from '../employment/record-store.js';
import type { EmploymentContext, PresetFields } from '../employment/types.js';
import { operationKey, plannedEffectiveDate } from '../employment/timeline.js';

export interface SequenceSource {
  readonly kind: 'posts' | 'positions';
  readonly id: string;
  readonly sequenceId: string;
  readonly revision: number;
}
export interface SequenceTarget {
  readonly payload: EmploymentPayloadRow;
  readonly fields: PresetFields;
  readonly customFields: EmploymentPayloadRow['customFields'];
  readonly revision: number;
  readonly effective: boolean;
  readonly source: SequenceSource;
}
export const SEQUENCE_TARGET_LIMIT = 1000;

/** 已落地快照优先于原始 record；未落地审批通过申请保留 deferred 字段供生效时解析。 */
export async function sequenceTargets(
  tx: Tx,
  ctx: EmploymentContext,
  sources: readonly SequenceSource[],
  targetIds?: readonly string[],
  includeUnchanged = false,
): Promise<SequenceTarget[]> {
  if (!sources.length || targetIds?.length === 0) return [];
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const references = sources.map((s) => {
    const field = sql.identifier(s.kind === 'posts' ? 'post_id' : 'position_id');
    return sql`(CASE WHEN p.is_record_snapshot OR r.id IS NULL THEN p.${field} ELSE r.${field} END)=${s.id}::uuid`;
  });
  const raw = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
    SELECT p.*,b.revision AS business_revision,s.state FROM employment_business_objects b
    JOIN LATERAL (SELECT * FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY event_no DESC LIMIT 1) s ON true
    LEFT JOIN employment_records r ON r.tenant_id=b.tenant_id AND r.id=b.id
    LEFT JOIN employment_timeline t ON t.tenant_id=b.tenant_id AND t.record_id=b.id
    WHERE b.tenant_id=${ctx.tenantId}
      AND ((s.state='effective' AND (t.valid_during @> ${today}::date OR t.start_date>${today}::date))
        OR (s.state='approved' AND r.id IS NULL))
      AND (${sql.join(references, sql` OR `)})
      ${targetIds ? sql`AND b.id=ANY(${`{${targetIds.join(',')}}`}::uuid[])` : sql``}
    ORDER BY b.employee_id, COALESCE(t.start_date,greatest(p.effective_date,${today}::date)),
      ${plannedEffectiveDate(ctx.tenantId, sql`b.id`, sql`p.effective_date`)},
      t.sort_order,${operationKey(ctx.tenantId, sql`b.id`)} LIMIT ${SEQUENCE_TARGET_LIMIT + 1}
  `),
  );
  if (raw.length > SEQUENCE_TARGET_LIMIT) throw new AppError('PAYLOAD_TOO_LARGE', '序列同步任职记录超过单次处理上限');
  const targets: SequenceTarget[] = [];
  for (const row of raw) {
    const { businessRevision, state, ...data } = camelRow(row);
    const payload = { ...data, fields: snapshotFields(data) } as unknown as EmploymentPayloadRow;
    const record =
      state === 'effective' ? await loadEmploymentRecord(tx, ctx.tenantId, payload.businessId, today) : null;
    const fields = record?.fields ?? payload.fields;
    const source = sources.find((s) => fields[s.kind === 'posts' ? 'postId' : 'positionId'] === s.id);
    if (!source || (!includeUnchanged && fields.sequenceId === source.sequenceId)) continue;
    targets.push({
      payload,
      fields,
      customFields: record?.customFields ?? payload.customFields,
      revision: Number(businessRevision),
      effective: state === 'effective',
      source,
    });
  }
  return targets;
}

export async function authorizeSequenceTargets(tx: Tx, ctx: EmploymentContext, targets: readonly SequenceTarget[]) {
  for (const target of targets) {
    await requireLinkedEmploymentRecord(
      tx,
      ctx,
      target.payload.employeeId,
      target.fields.departmentId,
      target.payload.businessId,
    );
    await requireEmploymentWrite(ctx, 'update', { sequenceId: target.source.sequenceId });
  }
}
