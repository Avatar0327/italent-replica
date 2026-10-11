/**
 * F-092 / DEC-416⑦：离职生效自动退出全部评审组，撤销不恢复。
 * 复用任职状态钩子（R3-T05 A3 / DEC-343）与 ev_sync_queue：到期在任职事务内移出，未来直接离职排队到期处理。
 */
import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_STATUS, tenantLocalDate } from '@italent/domain';
import { getEmployee } from '../employment/employees.js';
import { RECORD_CREATE_EVENT } from '../employment/record-events.js';
import {
  registerEmployeeStatusHooks,
  type EmployeeStatusHookContext,
  type EmployeeStatusHooks,
} from '../employment/status-hooks.js';
import { auditSnapshot, loadGroup } from './review-group-service.js';
import { audit, rowsOf } from './store.js';

export const REVIEW_GROUP_EXIT_HANDLER = 'review_group_exit';

/** 多员工结清与编辑目标组一起按 UUID 取锁，避免逐员工退组或先锁编辑目标造成组锁反转。 */
async function lockExitGroups(
  tx: Tx,
  ctx: EmployeeStatusHookContext,
  employeeIds: readonly string[],
  groupId?: string,
) {
  return rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT g.id FROM ev_review_groups g
    WHERE g.tenant_id=${ctx.tenantId} AND (g.id=${groupId ?? null}::uuid OR EXISTS (
      SELECT 1 FROM ev_review_members m WHERE m.tenant_id=g.tenant_id AND m.group_id=g.id
        AND m.employee_id=ANY(${`{${employeeIds.join(',')}}`}::uuid[]))) ORDER BY g.id FOR UPDATE OF g`),
  );
}

/** 调用方已持员工行锁；停用组同样移出，组长离职允许留下零组长 / 零成员（DEC-400②）。 */
export async function exitEmployeeReviewGroups(
  tx: Tx,
  ctx: EmployeeStatusHookContext,
  employeeIds: readonly string[],
): Promise<void> {
  if (!employeeIds.length) return;
  const leaving = new Set(employeeIds);
  const groups = await lockExitGroups(tx, ctx, employeeIds);
  for (const { id } of groups) {
    const before = await loadGroup(tx, ctx.tenantId, id);
    // 等组锁期间编辑可能已移出此员工，无事可做时不制造 revision 或审计。
    if (!before.members.some((member) => leaving.has(member.employeeId))) continue;
    await tx.execute(sql`DELETE FROM ev_review_members
      WHERE tenant_id=${ctx.tenantId} AND group_id=${id}
        AND employee_id=ANY(${`{${employeeIds.join(',')}}`}::uuid[])`);
    await tx.execute(sql`UPDATE ev_review_groups
      SET revision=revision+1, updated_at=${ctx.now.toISOString()}::timestamptz
      WHERE tenant_id=${ctx.tenantId} AND id=${id}`);
    await audit(tx, { ...ctx, expectedRevision: 0 }, 'reviewGroup', 'update', id, {
      before: await auditSnapshot(tx, ctx.tenantId, before),
      after: await auditSnapshot(tx, ctx.tenantId, await loadGroup(tx, ctx.tenantId, id)),
      orgId: before.ownerOrgId,
    });
  }
}

/**
 * 新成员写入前结清旧周期退出（DEC-416⑦）；不能因当前重聘在职而跳过旧组，也不能等失败退避后再误删新组。
 * 调用方已按 UUID 持全部员工锁。队列 → 全部相关组（含编辑目标）锁后刷新日期，未来重聘提前保存也走此处。
 */
export async function settleDueReviewGroupExits(
  tx: Tx,
  ctx: EmployeeStatusHookContext,
  employeeIds: readonly string[],
  clock: () => Date,
  groupId?: string,
): Promise<void> {
  if (!employeeIds.length) return;
  const queued = rowsOf<{ id: string; employeeId: string; effectiveDate: string }>(
    await tx.execute(sql`SELECT q.id, q.employee_id AS "employeeId", t.start_date::text AS "effectiveDate"
    FROM ev_sync_queue q
    JOIN employment_timeline t ON t.tenant_id=q.tenant_id AND t.record_id=q.record_id
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    JOIN LATERAL employment_record_status(t.tenant_id, t.record_id) st ON true
    WHERE q.tenant_id=${ctx.tenantId} AND q.handler=${REVIEW_GROUP_EXIT_HANDLER}
      AND q.employee_id=ANY(${`{${employeeIds.join(',')}}`}::uuid[]) AND q.state IN ('pending','failed')
      AND r.kind='leave' AND st.employee_status=${EMPLOYEE_STATUS.left}
    ORDER BY q.employee_id, q.seq FOR UPDATE OF q`),
  );
  if (!queued.length) return;
  await lockExitGroups(tx, ctx, [...new Set(queued.map((row) => row.employeeId))], groupId);
  const current = { ...ctx, now: clock() };
  const today = tenantLocalDate(current.now, current.timezone);
  const due = queued.filter((row) => row.effectiveDate <= today);
  await exitEmployeeReviewGroups(tx, current, [...new Set(due.map((row) => row.employeeId))]);
  for (const row of due) await settleReviewGroupExit(tx, current, row.id, 'done');
}

export async function settleReviewGroupExit(
  tx: Tx,
  ctx: EmployeeStatusHookContext,
  queueId: string,
  state: 'done' | 'skipped',
  reason: string | null = null,
): Promise<void> {
  await tx.execute(sql`UPDATE ev_sync_queue SET state=${state}, reason=${reason}, attempts=attempts+1,
    updated_at=${ctx.now.toISOString()}::timestamptz
    WHERE tenant_id=${ctx.tenantId} AND handler=${REVIEW_GROUP_EXIT_HANDLER} AND id=${queueId}::uuid`);
}

const hooks: EmployeeStatusHooks = {
  async onRecordMaterialized(tx, ctx, event) {
    if (event.kind !== 'leave' || event.employeeStatus !== EMPLOYEE_STATUS.left) return;
    // 记录 outbox 在钩子之前同事务写好；按记录判重，重放不重做，未来事件不被时间游标越过（F-055）。
    const [queued] = rowsOf<{ id: string }>(
      await tx.execute(sql`INSERT INTO ev_sync_queue
      (tenant_id, handler, dedupe_key, outbox_id, employee_id, record_id, next_attempt_at, created_at, updated_at)
      SELECT e.tenant_id, ${REVIEW_GROUP_EXIT_HANDLER}, e.object_id::text, e.id, e.employee_id, e.object_id,
        ${ctx.now.toISOString()}::timestamptz, ${ctx.now.toISOString()}::timestamptz,
        ${ctx.now.toISOString()}::timestamptz
      FROM employment_outbox e WHERE e.tenant_id=${ctx.tenantId} AND e.object_id=${event.recordId}::uuid
        AND e.event_type=${RECORD_CREATE_EVENT} AND e.employee_id=${event.employeeId}::uuid
      ON CONFLICT (tenant_id, handler, dedupe_key) DO NOTHING RETURNING id`),
    );
    if (!queued || event.effectiveDate > tenantLocalDate(ctx.now, ctx.timezone)) return;
    await exitEmployeeReviewGroups(tx, ctx, [event.employeeId]);
    await settleReviewGroupExit(tx, ctx, queued.id, 'done');
  },
  async onRecordDeleted(tx, ctx, event) {
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    if (event.kind === 'leave' && event.employeeStatus === EMPLOYEE_STATUS.left && event.effectiveDate <= today) {
      const [queued] = rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT id FROM ev_sync_queue
        WHERE tenant_id=${ctx.tenantId} AND handler=${REVIEW_GROUP_EXIT_HANDLER}
          AND record_id=${event.recordId}::uuid AND employee_id=${event.employeeId}::uuid
          AND state IN ('pending','failed') FOR UPDATE`),
      );
      // 生效后撤销须先完成尚未消费的退出；已结清的不重做，避免伤害撤销 / 重聘后合法新增的成员。
      if (queued) {
        await exitEmployeeReviewGroups(tx, ctx, [event.employeeId]);
        await settleReviewGroupExit(tx, ctx, queued.id, 'done');
      }
    }
    // 删除重聘等记录可能恢复到离职状态，旧队列即使已完成也须再次退组；生效前取消离职仍保留原组。
    if ((await getEmployee(tx, ctx.tenantId, event.employeeId, today)).status === 'left') {
      await settleDueReviewGroupExits(tx, ctx, [event.employeeId], () => ctx.now);
      await exitEmployeeReviewGroups(tx, ctx, [event.employeeId]);
    }
  },
};

export function registerReviewGroupExitHook(): void {
  registerEmployeeStatusHooks(REVIEW_GROUP_EXIT_HANDLER, hooks);
}
