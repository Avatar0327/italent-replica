import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_STATUS, ENTRY_STATUS } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { checkPage, rowsOf } from '../employment/read-model.js';
import type { EntryCaseWriteRef } from '../employment/onboarding-entry-port.js';
import type { PageQuery } from '../employment/types.js';
import type { PreparationTask } from './preparation-launch-state.js';

export type PreparationStatus = 'not_started' | 'in_progress' | 'completed' | 'closed';

export function preparationStatusSql(tenant: SQL, business: SQL) {
  return sql`(SELECT CASE
    WHEN bool_or(t.status='open') THEN 'in_progress'
    WHEN bool_or(t.status='scheduled') THEN
      CASE WHEN bool_or(t.status='completed') THEN 'in_progress' ELSE 'not_started' END
    WHEN bool_or(t.status='closed') THEN 'closed'
    WHEN bool_or(t.status='completed') THEN 'completed'
    ELSE 'not_started' END FROM (
      SELECT DISTINCT ON (task.item_id) task.status
      FROM onboarding_entry_cases c JOIN onboarding_preparation_tasks task
        ON task.tenant_id=c.tenant_id AND task.case_id=c.id
      WHERE c.tenant_id=${tenant} AND c.current_business_id=${business}
      ORDER BY task.item_id, (task.status<>'closed') DESC
    ) t)`;
}

/** 扫描只取候选。使用返回的旧版本发起时，业务头和阶段锁内拒绝已改期的候选。 */
export async function listDuePreparations(
  tx: Tx,
  tenantId: string,
  day: string,
  limit: number,
  after?: { dueOn: string; taskId: string },
) {
  checkPage({ limit, offset: 0 });
  return rowsOf<EntryCaseWriteRef & { taskId: string; itemId: string; dueOn: string }>(
    await tx.execute(sql`
    SELECT c.id AS "caseId", c.revision AS "caseRevision", c.employee_id AS "employeeId",
      b.id AS "businessId", b.revision AS "businessRevision",
      t.id AS "taskId", t.item_id AS "itemId", t.next_due_on::text AS "dueOn"
    FROM onboarding_preparation_tasks t
    JOIN onboarding_entry_cases c ON c.tenant_id=t.tenant_id AND c.id=t.case_id
    JOIN employment_business_objects b ON b.tenant_id=c.tenant_id AND b.id=c.current_business_id
    WHERE t.tenant_id=${tenantId} AND t.status='scheduled' AND t.next_due_on<=${day}::date
      AND c.state='pending' AND t.case_revision=c.revision
      ${after ? sql`AND (t.next_due_on, t.id)>(${after.dueOn}::date,${after.taskId}::uuid)` : sql``}
    ORDER BY t.next_due_on,t.id LIMIT ${limit}
  `),
  );
}

/** 本人只读当前受托任务的办理表单。生产读路由及动作权限在 16a-3b 接入。 */
export async function listMyPreparations(tx: Tx, tenantId: string, userId: string, page: PageQuery, taskId?: string) {
  checkPage(page);
  const rows = rowsOf<{ id: string; revision: number; form: PreparationTask['formSnapshot'] }>(
    await tx.execute(sql`
    SELECT t.id, t.revision, t.form_snapshot AS form FROM onboarding_preparation_assignees a
    JOIN tenant_memberships m ON m.tenant_id=a.tenant_id AND m.user_id=a.user_id AND m.status='active'
    JOIN onboarding_preparation_tasks t ON t.tenant_id=a.tenant_id AND t.id=a.task_id AND t.status='open'
    JOIN onboarding_entry_cases c ON c.tenant_id=t.tenant_id AND c.id=t.case_id
      AND c.state='pending' AND c.revision=t.case_revision
    JOIN LATERAL employment_record_status(c.tenant_id,c.current_business_id) s ON true
    WHERE s.employee_status=${EMPLOYEE_STATUS.pendingEntry}
      AND s.entry_status IS DISTINCT FROM ${ENTRY_STATUS.cancelled}
      AND a.tenant_id=${tenantId} AND a.user_id=${userId} AND a.status='open' AND tenant_account_active(a.user_id)
      ${taskId ? sql`AND t.id=${taskId}::uuid` : sql``}
    ORDER BY t.id LIMIT ${taskId ? 1 : page.limit} OFFSET ${taskId ? 0 : page.offset}
  `),
  );
  return rows.map(({ id, revision, form }) => ({
    id,
    revision,
    name: form.name,
    fields: form.fields.map(({ writeback: _writeback, ...field }) => field),
  }));
}
