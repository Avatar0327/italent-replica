/** F-092 / DEC-416⑦：所有退组和新增成员判断共用锁后的时刻、业务日期与任职状态口径。 */
import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_STATUS, tenantLocalDate } from '@italent/domain';
import { currentAuditRequest } from '../../audit/request-context.js';
import { getEmployee } from '../employment/employees.js';
import type { EmployeeStatusHookContext } from '../employment/status-hooks.js';
import { rowsOf } from './store.js';

export const REVIEW_GROUP_EXIT_HANDLER = 'review_group_exit';
interface LeavePoint {
  readonly kind: string;
  readonly employeeStatus: number;
  readonly effectiveDate: string | null;
}
interface QueuedExit extends LeavePoint {
  readonly id: string;
  readonly recordId: string;
  readonly employeeId: string;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
}
export interface ReviewGroupState<C extends EmployeeStatusHookContext = EmployeeStatusHookContext> {
  readonly ctx: C;
  readonly today: string;
  readonly queued: readonly QueuedExit[];
  readonly groups: readonly { id: string }[];
}

/**
 * 调用方已按 UUID 持有全部员工锁；此处先锁队列，再将全部成员组与编辑目标按 UUID 一起锁定。
 * 不提前按日期筛掉未来退出：取组锁也可能跨午夜。之后只采样一次时钟，判断和写入共用此快照。
 * HTTP 钩子复用请求注入的时钟；后台默认真实时钟，消费者可显式注入，绝不回退到请求开始的 ctx.now。
 */
export async function lockReviewGroupState<C extends EmployeeStatusHookContext>(
  tx: Tx,
  ctx: C,
  employeeIds: readonly string[],
  clock: () => Date = currentAuditRequest()?.clock ?? (() => new Date()),
  groupId?: string,
): Promise<ReviewGroupState<C>> {
  const ids = `{${employeeIds.join(',')}}`;
  const queued = rowsOf<QueuedExit>(
    await tx.execute(sql`SELECT q.id, q.record_id AS "recordId", q.employee_id AS "employeeId",
      q.attempts, q.next_attempt_at AS "nextAttemptAt", t.start_date::text AS "effectiveDate",
      r.kind, st.employee_status AS "employeeStatus"
    FROM ev_sync_queue q
    JOIN employment_records r ON r.tenant_id=q.tenant_id AND r.id=q.record_id
    JOIN LATERAL employment_record_status(r.tenant_id, r.id) st ON true
    LEFT JOIN employment_timeline t ON t.tenant_id=q.tenant_id AND t.record_id=q.record_id
    WHERE q.tenant_id=${ctx.tenantId} AND q.handler=${REVIEW_GROUP_EXIT_HANDLER}
      AND q.employee_id=ANY(${ids}::uuid[]) AND q.state IN ('pending','failed')
    ORDER BY q.employee_id, q.seq FOR UPDATE OF q`),
  );
  const groups = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT g.id FROM ev_review_groups g
    WHERE g.tenant_id=${ctx.tenantId} AND (g.id=${groupId ?? null}::uuid OR EXISTS (
      SELECT 1 FROM ev_review_members m WHERE m.tenant_id=g.tenant_id AND m.group_id=g.id
        AND m.employee_id=ANY(${ids}::uuid[]))) ORDER BY g.id FOR UPDATE OF g`),
  );
  const current = { ...ctx, now: clock() };
  return { ctx: current, today: tenantLocalDate(current.now, current.timezone), queued, groups };
}

/** 记录是否已触发退出与员工当前是否已重聘分别判断，旧周期不能因当前在职而漏结清。 */
export function isDueReviewGroupLeave(state: ReviewGroupState, record: LeavePoint): boolean {
  return (
    record.kind === 'leave' &&
    record.employeeStatus === EMPLOYEE_STATUS.left &&
    record.effectiveDate !== null &&
    record.effectiveDate <= state.today
  );
}

export async function reviewGroupEmployeeStatus(tx: Tx, state: ReviewGroupState, employeeId: string) {
  return (await getEmployee(tx, state.ctx.tenantId, employeeId, state.today)).status;
}
