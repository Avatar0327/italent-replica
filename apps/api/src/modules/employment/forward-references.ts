import { sql, type Tx } from '@italent/db';
import type { OrgId } from '@italent/domain';
import { tenantLocalDate } from '@italent/domain';
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

/** 停用只排除此字段，不取消其他合法字段。每次查询按租户、对象和日期限定。 */
export async function availableForwardChanges(
  tx: Tx,
  ctx: EmploymentContext,
  changes: readonly ForwardFieldChange[],
  dates: { source: string; target: string },
  coupled: boolean,
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
      // TODO(需取证 #13, Q-M0-24)：停用时点未定，日期间状态不一致时暂不传播该引用。
      for (const date of new Set([dates.source, dates.target, tenantLocalDate(ctx.now, ctx.timezone)])) {
        const key = `${change.field}:${change.after}:${date}`;
        let result = cache.get(key);
        if (result === undefined) {
          result = await enabled(tx, ctx, change.field, change.after, date);
          cache.set(key, result);
        }
        available &&= result;
      }
    }
    if (available) accepted.push(change);
    else skipped.push(change.field);
  }
  if (coupled && skipped.some((field) => field === 'positionId' || field === 'departmentId')) {
    return { accepted: accepted.filter((change) => !['positionId', 'departmentId'].includes(change.field)), skipped };
  }
  return { accepted, skipped };
}
