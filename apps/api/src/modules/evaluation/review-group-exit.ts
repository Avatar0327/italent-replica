/**
 * F-092 / DEC-416⑦：离职生效自动退出全部评审组，撤销不恢复。
 * 复用任职状态钩子（R3-T05 A3 / DEC-343）与 ev_sync_queue：到期在任职事务内移出，未来直接离职排队到期处理。
 */
import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_STATUS, tenantLocalDate } from '@italent/domain';
import { RECORD_CREATE_EVENT } from '../employment/record-events.js';
import {
  registerEmployeeStatusHooks,
  type EmployeeStatusHookContext,
  type EmployeeStatusHooks,
} from '../employment/status-hooks.js';
import { auditSnapshot, loadGroup } from './review-group-service.js';
import { audit, rowsOf } from './store.js';

export const REVIEW_GROUP_EXIT_HANDLER = 'review_group_exit';

/** 调用方已持员工行锁；全部组按 UUID 取锁，停用组同样移出，组长离职允许留下零组长 / 零成员（DEC-400②）。 */
export async function exitEmployeeReviewGroups(
  tx: Tx,
  ctx: EmployeeStatusHookContext,
  employeeId: string,
): Promise<void> {
  const groups = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT g.id FROM ev_review_groups g
    JOIN ev_review_members m ON m.tenant_id=g.tenant_id AND m.group_id=g.id
    WHERE g.tenant_id=${ctx.tenantId} AND m.employee_id=${employeeId}::uuid ORDER BY g.id FOR UPDATE OF g`),
  );
  for (const { id } of groups) {
    const before = await loadGroup(tx, ctx.tenantId, id);
    // 等组锁期间编辑可能已移出此员工，无事可做时不制造 revision 或审计。
    if (!before.members.some((member) => member.employeeId === employeeId)) continue;
    await tx.execute(sql`DELETE FROM ev_review_members
      WHERE tenant_id=${ctx.tenantId} AND group_id=${id} AND employee_id=${employeeId}`);
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
    await exitEmployeeReviewGroups(tx, ctx, event.employeeId);
    await settleReviewGroupExit(tx, ctx, queued.id, 'done');
  },
  // 不登记 onRecordDeleted：撤销离职只恢复任职状态，成员不恢复；未到期队列由消费者复核为 gone。
};

export function registerReviewGroupExitHook(): void {
  registerEmployeeStatusHooks(REVIEW_GROUP_EXIT_HANDLER, hooks);
}
