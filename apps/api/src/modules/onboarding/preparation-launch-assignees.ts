import { sql, type PreparationSelector, type Tx } from '@italent/db';
import { EMPLOYEE_STATUS, TERMINATING_EMPLOYEE_STATUSES } from '@italent/domain';
import { isEligibleApprover, userOfPerson } from '../approval/resolver.js';
import { rowsOf } from '../employment/read-model.js';
import type { EmploymentRecord } from '../employment/types.js';

const MAX_ASSIGNEES = 200;

async function selectedUsers(tx: Tx, record: EmploymentRecord, day: string, selector: PreparationSelector) {
  const { tenantId, fields } = record;
  if (selector.kind === 'member') return [selector.id];
  if (selector.kind === 'direct_manager') return [await userOfPerson(tx, tenantId, fields.directManagerId)];
  if (selector.kind === 'department_head' || selector.kind === 'hrbp') {
    const [org] = rowsOf<{ head: string | null; hrbp: string | null }>(
      await tx.execute(sql`
      SELECT person_in_charge_id AS head, hrbp_id AS hrbp FROM (
        SELECT * FROM org_versions WHERE tenant_id=${tenantId} AND org_id=${fields.departmentId}::uuid
          AND start_date<=${day}::date ORDER BY start_date DESC, version_no DESC LIMIT 1
      ) current_org WHERE stop_date>=${day}::date AND enabled
    `),
    );
    return [await userOfPerson(tx, tenantId, (selector.kind === 'department_head' ? org?.head : org?.hrbp) ?? null)];
  }
  const source =
    selector.kind === 'identity'
      ? sql`SELECT user_id FROM permission_grants
        WHERE tenant_id=${tenantId} AND profile_id=${selector.id}::uuid AND status='active'`
      : assigneesAtJob(record.tenantId, day, selector.kind, selector.id!);
  return rowsOf<{ user_id: string }>(
    await tx.execute(sql`
    SELECT DISTINCT q.user_id FROM (${source}) q
    JOIN tenant_memberships m ON m.tenant_id=${tenantId} AND m.user_id=q.user_id AND m.status='active'
    WHERE tenant_account_active(q.user_id) ORDER BY q.user_id LIMIT ${MAX_ASSIGNEES + 1}
  `),
  ).map(({ user_id }) => user_id);
}

function assigneesAtJob(tenantId: string, day: string, kind: 'position' | 'post', id: string) {
  const column = kind === 'position' ? sql`position_id` : sql`post_id`;
  return sql`
    SELECT l.user_id FROM permission_user_person_links l
    JOIN employment_timeline t ON t.tenant_id=l.tenant_id AND t.employee_id=l.employee_id
      AND t.valid_during @> ${day}::date
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    LEFT JOIN LATERAL (
      SELECT p.id,p.${column} FROM employment_payload_versions p WHERE p.tenant_id=r.tenant_id
        AND p.business_id=r.id AND p.is_record_snapshot ORDER BY p.version_no DESC LIMIT 1
    ) p ON true
    JOIN LATERAL employment_record_status(r.tenant_id,r.id) state ON true
    WHERE l.tenant_id=${tenantId} AND r.service_type='primary'
      AND state.employee_status NOT IN (${EMPLOYEE_STATUS.pendingEntry}, ${sql.join(
        TERMINATING_EMPLOYEE_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      )})
      AND (CASE WHEN p.id IS NULL THEN r.${column} ELSE p.${column} END)=${id}::uuid
  `;
}

export async function resolvePreparationAssignees(
  tx: Tx,
  record: EmploymentRecord,
  day: string,
  selectors: PreparationSelector[],
) {
  const candidates = new Set<string>();
  for (const selector of selectors) {
    for (const userId of await selectedUsers(tx, record, day, selector)) if (userId) candidates.add(userId);
    if (candidates.size > MAX_ASSIGNEES) return { code: 'PREPARATION_ASSIGNEE_LIMIT' } as const;
  }
  const users: string[] = [];
  const subject = { tenantId: record.tenantId, asOf: day, cache: new Map<string, Promise<unknown>>() };
  for (const userId of [...candidates].sort()) if (await isEligibleApprover(tx, subject, userId)) users.push(userId);
  return users.length ? { users } : ({ code: 'PREPARATION_ASSIGNEE_EMPTY' } as const);
}
