import { randomUUID } from 'node:crypto';
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
    SELECT e.business_id AS id,e.employee_id AS "employeeId",t.start_date::text AS "effectiveDate",
      COALESCE(p.body,to_jsonb(current_record))->>'department_id' AS "departmentId",
      jsonb_agg(code.value ORDER BY code.ordinality) AS "fieldCodes"
    FROM employment_outbox e
    JOIN employment_records r ON r.tenant_id=e.tenant_id AND r.id=e.business_id
    JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
    JOIN employment_timeline current_t ON current_t.tenant_id=e.tenant_id AND current_t.employee_id=e.employee_id
      AND current_t.valid_during @> ${tenantLocalDate(ctx.now, ctx.timezone)}::date
    JOIN employment_records current_record ON current_record.tenant_id=current_t.tenant_id
      AND current_record.id=current_t.record_id
      AND current_record.service_type='primary'
    LEFT JOIN LATERAL (SELECT to_jsonb(p) AS body FROM employment_payload_versions p
      WHERE p.tenant_id=current_record.tenant_id AND p.business_id=current_record.id AND p.is_record_snapshot
      ORDER BY version_no DESC LIMIT 1) p ON true
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(
      e.payload->'meta'->'clearedFieldCodes', e.payload->'after'->'clearedFieldCodes','[]'::jsonb
    )) WITH ORDINALITY code(value,ordinality)
    WHERE e.tenant_id=${ctx.tenantId} AND e.event_type='employment.record.create'
      AND t.start_date<=${tenantLocalDate(ctx.now, ctx.timezone)}::date
      AND code.value LIKE 'preset:%'
      AND (COALESCE(p.body,to_jsonb(current_record))->>lower(regexp_replace(
        substring(code.value FROM 8), '([A-Z])', '_\\1', 'g'))) IS NULL
    GROUP BY e.business_id,e.employee_id,t.start_date,current_record.id,p.body
  `;
}
export interface CompletionTodo {
  readonly id: string;
  readonly employeeId: string;
  readonly effectiveDate: string;
  readonly departmentId: string | null;
  readonly fieldCodes: string[];
  readonly todoIds?: string[];
  readonly legacyReminderDate?: string | null;
}
function openTodos(ctx: EmploymentContext) {
  return sql`SELECT c.business_id AS id,c.employee_id AS "employeeId",min(c.effective_date)::text AS "effectiveDate",
    jsonb_agg(DISTINCT c.field_code ORDER BY c.field_code) AS "fieldCodes",
    jsonb_agg(DISTINCT c.id ORDER BY c.id) AS "todoIds", latest."departmentId",
    max(c.legacy_reminder_date)::text AS "legacyReminderDate"
    FROM transfer_completion_todos c JOIN (${completionQuery(ctx)}) latest
      ON latest."employeeId"=c.employee_id AND latest."fieldCodes" ? c.field_code
    WHERE c.tenant_id=${ctx.tenantId} AND c.closed_at IS NULL
      AND c.effective_date<=${tenantLocalDate(ctx.now, ctx.timezone)}::date
    GROUP BY c.business_id,c.employee_id,latest."departmentId"`;
}
export async function listCompletionTodos(tx: Tx, ctx: EmploymentContext, page: PageQuery) {
  const scope = employmentScopePredicate(
    ctx.scope,
    sql`c."employeeId"`,
    sql`c."departmentId"::uuid`,
    employmentCreator(ctx.tenantId, sql`c.id`, true),
  );
  return rowsOf<CompletionTodo>(
    await tx.execute(sql`SELECT c.id,c."employeeId",c."effectiveDate",c."departmentId",c."fieldCodes",c."todoIds"
    FROM (${openTodos(ctx)}) c
    WHERE ${scope} ORDER BY c."effectiveDate",c.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
}

/** 持员工锁的写入/调度端口同步生命周期；读取不会复活旧待办。 */
export async function reconcileCompletion(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const missing = rowsOf<CompletionTodo>(
    await tx.execute(sql`SELECT * FROM (${completionQuery(ctx)}) c
    WHERE c."employeeId"=${employeeId}::uuid ORDER BY c."effectiveDate",c.id`),
  );
  const desired = new Map<string, CompletionTodo>();
  for (const item of missing) for (const code of item.fieldCodes) desired.set(code, item);
  const open = rowsOf<{ id: string; businessId: string; fieldCode: string; effectiveDate: string }>(
    await tx.execute(sql`
    SELECT id,business_id AS "businessId",field_code AS "fieldCode",
      effective_date::text AS "effectiveDate" FROM transfer_completion_todos
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND closed_at IS NULL
      FOR UPDATE`),
  );
  for (const item of open) {
    if (item.effectiveDate <= tenantLocalDate(ctx.now, ctx.timezone) && desired.has(item.fieldCode)) {
      desired.delete(item.fieldCode);
      continue;
    }
    await tx.execute(sql`UPDATE transfer_completion_todos SET closed_at=${ctx.now.toISOString()}::timestamptz
      WHERE tenant_id=${ctx.tenantId} AND id=${item.id}::uuid AND closed_at IS NULL`);
    await auditEmployment(tx, ctx, 'employment.completion.closed', 'employment-business', item.businessId, null, {
      todoId: item.id,
      fieldCode: item.fieldCode,
    });
  }
  for (const [fieldCode, item] of desired) {
    await openCompletion(tx, ctx, employeeId, item.id, fieldCode, tenantLocalDate(ctx.now, ctx.timezone));
  }
}

export async function openCompletion(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  businessId: string,
  fieldCode: string,
  effectiveDate: string,
) {
  if (effectiveDate > tenantLocalDate(ctx.now, ctx.timezone)) return;
  const id = randomUUID();
  const inserted = rowsOf(
    await tx.execute(sql`INSERT INTO transfer_completion_todos
    (id,tenant_id,employee_id,business_id,field_code,effective_date,created_at)
    VALUES (${id}::uuid,${ctx.tenantId},${employeeId}::uuid,${businessId}::uuid,${fieldCode},
      ${effectiveDate}::date,${ctx.now.toISOString()}::timestamptz)
    ON CONFLICT (tenant_id,employee_id,field_code) WHERE closed_at IS NULL DO NOTHING RETURNING id`),
  );
  if (inserted.length)
    await auditEmployment(tx, ctx, 'employment.completion.opened', 'employment-business', businessId, null, {
      todoId: id,
      fieldCode,
    });
}
export function completionCandidates(ctx: EmploymentContext) {
  return sql`SELECT DISTINCT c."employeeId" FROM (${completionQuery(ctx)}) c
    WHERE NOT EXISTS (SELECT 1 FROM employment_outbox reminder
      WHERE reminder.tenant_id=${ctx.tenantId} AND reminder.business_id=c.id
        AND reminder.event_type='employment.completion.reminder'
        AND (reminder.payload->'after'->>'businessDate')::date >
          ${tenantLocalDate(ctx.now, ctx.timezone)}::date - ${COMPLETION_REMINDER_DAYS}::int)
    OR EXISTS (SELECT 1 FROM transfer_completion_todos todo WHERE todo.tenant_id=${ctx.tenantId}
      AND todo.employee_id=c."employeeId" AND todo.closed_at IS NULL
      AND todo.effective_date<=${tenantLocalDate(ctx.now, ctx.timezone)}::date
      AND (todo.legacy_reminder_date IS NULL OR todo.legacy_reminder_date <=
        ${tenantLocalDate(ctx.now, ctx.timezone)}::date - ${COMPLETION_REMINDER_DAYS}::int)
      AND NOT EXISTS (SELECT 1 FROM employment_outbox reminder WHERE reminder.tenant_id=${ctx.tenantId}
        AND reminder.employee_id=todo.employee_id AND reminder.event_type='employment.completion.reminder'
        AND reminder.payload->'after'->'todoIds' ? todo.id::text))
    UNION SELECT employee_id AS "employeeId" FROM transfer_completion_todos todo
      WHERE tenant_id=${ctx.tenantId} AND closed_at IS NULL
        AND effective_date<=${tenantLocalDate(ctx.now, ctx.timezone)}::date AND NOT EXISTS (
        SELECT 1 FROM (${completionQuery(ctx)}) c WHERE c."employeeId"=todo.employee_id
          AND c."fieldCodes" ? todo.field_code)`;
}
/** 调度器持员工锁后调用；同一员工/业务/周期只发布一次可靠提醒，接收者沿 HR 待办实时权限解析。 */
export async function remindCompletion(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  await reconcileCompletion(tx, ctx, employeeId);
  const items = rowsOf<CompletionTodo>(
    await tx.execute(sql`SELECT c.* FROM (${openTodos(ctx)}) c
    WHERE c."employeeId"=${employeeId}::uuid ORDER BY c.id LIMIT 201`),
  );
  if (items.length > 200) throw new AppError('PAYLOAD_TOO_LARGE', '单员工待补全业务超过处理上限');
  for (const item of items) {
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const [previous] = rowsOf<{ businessDate: string }>(
      await tx.execute(sql`
      SELECT payload->'after'->>'businessDate' AS "businessDate" FROM employment_outbox
      WHERE tenant_id=${ctx.tenantId} AND business_id=${item.id}::uuid
        AND event_type='employment.completion.reminder'
        AND payload->'after'->'todoIds'=${JSON.stringify(item.todoIds ?? [])}::jsonb
      ORDER BY created_at DESC,id DESC LIMIT 1
    `),
    );
    const lastReminder = [previous?.businessDate, item.legacyReminderDate]
      .filter((date): date is string => !!date)
      .sort()
      .at(-1);
    if (lastReminder && Date.parse(today) - Date.parse(lastReminder) < COMPLETION_REMINDER_DAYS * 86400000) continue;
    await auditEmployment(tx, ctx, 'employment.completion.reminder', 'employment-business', item.id, null, {
      title: '任职信息待补全',
      todoIds: item.todoIds ?? [],
      businessDate: today,
      fieldCodes: item.fieldCodes,
      audience: 'authorized-hr',
      completionMethod: 'edit-employment-record',
    });
  }
}
