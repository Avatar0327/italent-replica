/** DEC-163；用户确认：通过现有编辑任职补全，每 7 个租户自然日提醒。 */
import { AppError } from '../../errors.js';
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { auditEmployment, employmentCreator, employmentScopePredicate } from '../employment/context.js';
import { rowsOf } from '../employment/record-store.js';
import type { EmploymentContext, PageQuery } from '../employment/types.js';

export const COMPLETION_REMINDER_DAYS = 7;

/** canonical: payload.meta.clearedFieldCodes；只读兼容 PR-A 旧事件，绝不把该键当作任职字段。 */
function completionQuery(ctx: EmploymentContext) {
  return sql`
    SELECT e.business_id AS id,e.employee_id AS "employeeId",r.start_date::text AS "effectiveDate",
      COALESCE(p.body,to_jsonb(r))->>'department_id' AS "departmentId",
      jsonb_agg(code.value ORDER BY code.ordinality) AS "fieldCodes"
    FROM employment_outbox e
    JOIN employment_records r ON r.tenant_id=e.tenant_id AND r.id=e.business_id
    JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
    LEFT JOIN LATERAL (SELECT to_jsonb(p) AS body FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
      ORDER BY version_no DESC LIMIT 1) p ON true
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(
      e.payload->'meta'->'clearedFieldCodes', e.payload->'after'->'clearedFieldCodes','[]'::jsonb
    )) WITH ORDINALITY code(value,ordinality)
    WHERE e.tenant_id=${ctx.tenantId} AND e.event_type='employment.record.create'
      AND r.start_date<=${tenantLocalDate(ctx.now, ctx.timezone)}::date
      AND code.value LIKE 'preset:%'
      AND (COALESCE(p.body,to_jsonb(r))->>lower(regexp_replace(
        substring(code.value FROM 8), '([A-Z])', '_\\1', 'g'))) IS NULL
    GROUP BY e.business_id,e.employee_id,r.start_date,r.id,p.body
  `;
}
export interface CompletionTodo {
  readonly id: string;
  readonly employeeId: string;
  readonly effectiveDate: string;
  readonly departmentId: string | null;
  readonly fieldCodes: string[];
}
export async function listCompletionTodos(tx: Tx, ctx: EmploymentContext, page: PageQuery) {
  const scope = employmentScopePredicate(
    ctx.scope,
    sql`c."employeeId"`,
    sql`c."departmentId"::uuid`,
    employmentCreator(ctx.tenantId, sql`c.id`, true),
  );
  return rowsOf<CompletionTodo>(
    await tx.execute(sql`SELECT c.* FROM (${completionQuery(ctx)}) c
    WHERE ${scope} ORDER BY c."effectiveDate",c.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
}
export function completionCandidates(ctx: EmploymentContext) {
  return sql`SELECT c."employeeId" FROM (${completionQuery(ctx)}) c`;
}
/** 调度器持员工锁后调用；同一员工/业务/周期只发布一次可靠提醒，接收者沿 HR 待办实时权限解析。 */
export async function remindCompletion(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const items = rowsOf<CompletionTodo>(
    await tx.execute(sql`SELECT c.* FROM (${completionQuery(ctx)}) c
    WHERE c."employeeId"=${employeeId}::uuid ORDER BY c.id LIMIT 201`),
  );
  if (items.length > 200) throw new AppError('PAYLOAD_TOO_LARGE', '单员工待补全业务超过处理上限');
  for (const item of items) {
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const [previous] = rowsOf<{ businessDate: string }>(
      await tx.execute(sql`
      SELECT payload->'after'->>'businessDate' AS "businessDate" FROM employment_outbox
      WHERE tenant_id=${ctx.tenantId} AND business_id=${item.id}::uuid
        AND event_type='employment.completion.reminder' ORDER BY created_at DESC,id DESC LIMIT 1
    `),
    );
    if (previous && Date.parse(today) - Date.parse(previous.businessDate) < COMPLETION_REMINDER_DAYS * 86400000)
      continue;
    await auditEmployment(tx, ctx, 'employment.completion.reminder', 'employment-business', item.id, null, {
      title: '任职信息待补全',
      businessDate: today,
      fieldCodes: item.fieldCodes,
      audience: 'authorized-hr',
      completionMethod: 'edit-employment-record',
    });
  }
}
