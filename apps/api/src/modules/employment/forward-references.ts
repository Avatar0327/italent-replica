import { sql, type Tx } from '@italent/db';
import type { OrgId } from '@italent/domain';
import { createTxOrgHierarchyReader } from '../establishment/org-reader.js';
import { loadJobObject } from '../job/read-model.js';
import type { JobKind } from '../job/metadata.js';
import { rowsOf } from './record-store.js';
import type { ForwardFieldChange } from './forward-rules.js';
import type { EmploymentContext } from './types.js';

const JOB_REFERENCES: Readonly<Record<string, JobKind>> = {
  positionId: 'positions',
  postId: 'posts',
  levelId: 'levels',
  gradeId: 'grades',
  sequenceId: 'sequences',
  professionalLineId: 'professional-lines',
};

async function enabled(tx: Tx, ctx: EmploymentContext, field: string, id: string, date: string): Promise<boolean> {
  if (field === 'departmentId') {
    return createTxOrgHierarchyReader(tx).isEnabled({ tenantId: ctx.tenantId, orgId: id as OrgId, asOf: date });
  }
  const kind = JOB_REFERENCES[field];
  if (kind) return !!(await loadJobObject(tx, ctx.tenantId, kind, id, date));
  if (field !== 'directManagerId' && field !== 'dottedManagerId') return true;
  const [row] = rowsOf(
    await tx.execute(sql`
    SELECT 1 FROM employment_timeline t JOIN employment_records r
      ON r.tenant_id=t.tenant_id AND r.employee_id=t.employee_id AND r.id=t.record_id
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${id}::uuid
      AND t.valid_during @> ${date}::date AND r.kind NOT IN ('leave','retirement') LIMIT 1
  `),
  );
  return !!row;
}

/**
 * 特殊规则①“引用值已停用”的判断日（DEC-079；DEC-110 用户 2026-10-03 确认维持）：按被更新的后续记录自己的
 * 生效日判断，与补录日、当天无关，同一补录何时执行结果都一致。原站按补录日或当天判断，会把已停用组织写进
 * 未来记录（W-406），复刻有意不照搬。
 */
export function referenceCheckDate(target: { readonly effectiveDate: string }): string {
  return target.effectiveDate;
}

/** 停用只排除此字段，不取消其他合法字段。每次查询按租户、对象和日期限定；targetDate 取 referenceCheckDate。 */
export async function availableForwardChanges(
  tx: Tx,
  ctx: EmploymentContext,
  changes: readonly ForwardFieldChange[],
  targetDate: string,
  cache: Map<string, boolean>,
): Promise<{ accepted: ForwardFieldChange[]; skipped: string[] }> {
  const accepted: ForwardFieldChange[] = [];
  const skipped: string[] = [];
  for (const change of changes) {
    let available = true;
    const reference =
      change.field === 'departmentId' ||
      change.field in JOB_REFERENCES ||
      change.field === 'directManagerId' ||
      change.field === 'dottedManagerId';
    if (reference && typeof change.after === 'string') {
      const key = `${change.field}:${change.after}:${targetDate}`;
      let result = cache.get(key);
      if (result === undefined) {
        result = await enabled(tx, ctx, change.field, change.after, targetDate);
        cache.set(key, result);
      }
      available = result;
    }
    if (available) accepted.push(change);
    else skipped.push(change.field);
  }
  return { accepted, skipped };
}
