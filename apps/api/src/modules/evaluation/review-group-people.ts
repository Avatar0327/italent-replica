/** F-092 / DEC-416⑦：评审组成员的员工锁与当前在职校验。 */
import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_STATUS } from '@italent/domain';
import { AppError } from '../../errors.js';
import { reviewGroupEmployeeStatus, type ReviewGroupState } from './review-group-state.js';
import { lockEmploymentEmployee, rowsOf } from '../employment/record-store.js';
import type { EvaluationContext } from './access.js';

/**
 * 与任职离职共享员工锁；先员工（UUID 排序）再评审组，避免离职“员工 → 组”与编辑产生锁序反转。
 * 编辑锁住当前成员与提交成员的并集；随后组锁内校验 revision，保证读成员到取组锁之间的变化不会被旧表单覆盖。
 */
export async function lockReviewGroupPeople(
  tx: Tx,
  ctx: EvaluationContext,
  submitted: readonly string[],
  groupId?: string,
): Promise<void> {
  const current = groupId
    ? rowsOf<{ employee_id: string }>(
        await tx.execute(sql`SELECT employee_id
    FROM ev_review_members WHERE tenant_id=${ctx.tenantId} AND group_id=${groupId}::uuid`),
      )
    : [];
  const ids = [...new Set([...submitted, ...current.map((row) => row.employee_id)])].sort();
  if (!ids.length) return;
  // 不存在 / 跨租户的 ID 不在这里报错，仍由原有的新增引用范围校验统一返回“人员不存在”。
  const found = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM employment_employees
    WHERE tenant_id=${ctx.tenantId} AND id=ANY(${`{${ids.join(',')}}`}::uuid[]) ORDER BY id`),
  );
  for (const person of found) await lockEmploymentEmployee(tx, ctx, person.id);
}

/** 新增引用已通过人员范围校验；旧周期结清和当前在职校验必须用同一个锁后快照。 */
export async function requireEmployedReviewMembers(tx: Tx, state: ReviewGroupState, ids: readonly string[]) {
  for (const id of ids) {
    if ((await reviewGroupEmployeeStatus(tx, state, id)) !== 'employed') {
      throw new AppError('VALIDATION_FAILED', '评审组成员必须是在职员工', {
        reason: 'REVIEW_GROUP_MEMBER_NOT_EMPLOYED',
      });
    }
  }
}

/** 与 employment/employees.ts 的 status='employed' 一致：有当前主职，且非待入职、退休、离职。 */
export const employedReviewMemberSql = (today: string) => sql`EXISTS (SELECT 1 FROM employment_timeline t
  JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
  JOIN LATERAL employment_record_status(t.tenant_id, t.record_id) st ON true
  WHERE t.tenant_id=e.tenant_id AND t.employee_id=e.id AND t.valid_during @> ${today}::date
    AND st.employee_status NOT IN (
      ${EMPLOYEE_STATUS.pendingEntry},${EMPLOYEE_STATUS.retired},${EMPLOYEE_STATUS.left}))`;
