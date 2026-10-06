/** F-007 / F-017：只读推演调动落地时对组织调整的传播，不让复制快照截断未来占编。 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { applyForwardChanges, matchingForwardChanges, type ForwardValues } from './forward-rules.js';
import { availableForwardChanges } from './forward-references.js';
import { loadEmploymentRecord } from './read-model.js';
import { rowsOf } from './record-store.js';
import { employmentTimelineNeighbors } from './timeline.js';
import type { EmploymentContext, EmploymentRecord } from './types.js';

export async function projectOrgAdjustmentRecords(
  tx: Tx,
  ctx: EmploymentContext,
  source: {
    employeeId: string;
    businessId: string;
    effectiveDate: string;
    before: EmploymentRecord;
    after: ForwardValues;
  },
  projected: Map<string, EmploymentRecord>,
): Promise<EmploymentRecord[]> {
  const { next } = await employmentTimelineNeighbors(
    tx,
    ctx,
    source.employeeId,
    source.effectiveDate,
    source.businessId,
  );
  if (!next) return [];
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT r.id FROM employment_timeline t JOIN employment_records r
      ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${source.employeeId}::uuid
      AND r.staff_id=${source.before.staffId}::uuid AND r.kind='org_adjustment'
      AND (t.start_date,t.sort_order)>=(${next.startDate}::date,${next.sortOrder})
    ORDER BY t.start_date,t.sort_order LIMIT 1001`),
  );
  if (rows.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '组织调整投影超过单次处理上限');
  const results: EmploymentRecord[] = [];
  const cache = new Map<string, boolean>();
  for (const row of rows) {
    const target =
      projected.get(row.id) ?? (await loadEmploymentRecord(tx, ctx.tenantId, row.id, source.effectiveDate));
    if (!target) continue;
    // 控编只读取预置字段；与落地共用值匹配、整条跳过、引用有效性及循环汇报规则。
    const changes = matchingForwardChanges(source.before, source.after, target, []);
    const { accepted } = await availableForwardChanges(tx, ctx, changes, target.effectiveDate, cache, {
      employeeId: source.employeeId,
      businessId: target.id,
      effectiveDate: target.effectiveDate,
      effective: true,
    });
    if (!accepted.length) continue;
    const updated = { ...target, ...applyForwardChanges(target, accepted) };
    projected.set(row.id, updated);
    results.push(updated);
  }
  return results;
}
