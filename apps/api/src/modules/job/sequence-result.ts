/** DEC-219：保留冻结集合中每条记录的执行结果，历史等跳过也必须有回执。 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { recordOperationLog } from '../../audit/record.js';
import { rowsOf } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import type { SequenceRequest } from './sequence-sync.js';
import type { SequenceTarget } from './sequence-targets.js';
export interface SequenceResultRow {
  recordId: string;
  employeeId: string | null;
  orgId: string | null;
  reason: string | null;
}
export async function sequenceResults(
  tx: Tx,
  ctx: EmploymentContext,
  request: SequenceRequest,
  targets: readonly SequenceTarget[],
) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const rows = rowsOf<{ id: string; employeeId: string; orgId: string | null; state: string; historical: boolean }>(
    await tx.execute(sql`
    SELECT b.id,b.employee_id AS "employeeId",
      CASE WHEN p.is_record_snapshot OR r.id IS NULL THEN p.department_id ELSE r.department_id END AS "orgId",s.state,
      (s.state='effective' AND NOT (t.valid_during @> ${today}::date OR t.start_date>${today}::date)) AS historical
    FROM employment_business_objects b
    JOIN LATERAL (SELECT *
      FROM employment_payload_versions
      WHERE tenant_id=b.tenant_id AND business_id=b.id ORDER BY version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state
      FROM employment_state_events
      WHERE tenant_id=b.tenant_id AND business_id=b.id ORDER BY event_no DESC LIMIT 1) s ON true
    LEFT JOIN employment_records r ON r.tenant_id=b.tenant_id AND r.id=b.id
    LEFT JOIN employment_timeline t ON t.tenant_id=b.tenant_id AND t.record_id=b.id
    WHERE b.tenant_id=${ctx.tenantId} AND b.id=ANY(${`{${request.targetIds.join(',')}}`}::uuid[])
  `),
  );
  return request.targetIds.map((recordId): SequenceResultRow => {
    const row = rows.find((row) => row.id === recordId);
    const target = targets.find((target) => target.payload.businessId === recordId);
    const reason = target
      ? target.fields.sequenceId === target.source.sequenceId
        ? 'UNCHANGED'
        : null
      : !row
        ? 'MISSING'
        : row.historical
          ? 'BECAME_HISTORICAL'
          : row.state === 'voided'
            ? 'VOIDED'
            : ['effective', 'approved', 'in_review'].includes(row.state)
              ? 'REFERENCE_CHANGED'
              : 'STATE_INELIGIBLE';
    return { recordId, employeeId: row?.employeeId ?? null, orgId: row?.orgId ?? null, reason };
  });
}
export async function auditSequenceResult(
  tx: Tx,
  ctx: EmploymentContext,
  taskId: string,
  rows: readonly SequenceResultRow[],
) {
  const skipped = rows.filter((row) => row.reason && row.reason !== 'UNCHANGED');
  await recordOperationLog(tx, {
    tenantId: ctx.tenantId,
    actorUserId: null,
    behavior: 'batch_update',
    objectType: 'job-sequence-sync',
    objectId: taskId,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    successCount: rows.length - skipped.length,
    failureCount: skipped.length,
    items: rows.map((row, rowIndex) => ({
      rowIndex,
      objectId: row.recordId,
      employeeId: row.employeeId,
      orgId: row.orgId,
      outcome: row.reason && row.reason !== 'UNCHANGED' ? 'failed' : 'succeeded',
    })),
    errorReport: rows.flatMap((row, rowIndex) =>
      row.reason && row.reason !== 'UNCHANGED' ? [{ rowIndex, errorCode: row.reason, reason: row.reason }] : [],
    ),
  });
}
