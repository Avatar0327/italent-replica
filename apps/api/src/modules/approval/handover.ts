/**
 * 异常管理员交接（DEC-098）：异常管理员停用前必须指定替代人——引用其为异常管理员的流程以当前版本为底稿重新发布，
 * 其名下在办的异常任务转给替代人；之后才允许撤销其成员关系（迁移 0028 触发器把关）。
 * 已在途实例冻结在旧版本，旧异常管理员停用后新产生的异常任务由租户管理员接管（engine.exceptionAdminFor）。
 */
import { sql, type Tx } from '@italent/db';
import { avoidSelfExceptionAdmin, isSelf, type Candidate } from '@italent/domain';
import { approvalError, assertRevision, rowsOf, type ApprovalContext } from './context.js';
import { assertExceptionAdminMember, republishWithExceptionAdmin } from './definitions.js';
import { currentRouting, openRun, persistRun } from './engine.js';
import { notifyTodo } from './notifications.js';
import { directManagerOf, personOfUser } from './resolver.js';
import { appendLog, closeTask, insertTask, loadTasks } from './store.js';

/** 单次交接的规模上限（DEC-101：只限制单次操作规模），超出时返回 remaining，由管理员再次提交。 */
const BATCH = 200;

export interface HandoverInput {
  readonly fromUserId: string;
  readonly toUserId: string;
}

export async function handoverExceptionAdmin(tx: Tx, ctx: ApprovalContext, input: HandoverInput) {
  assertRevision(ctx.expectedRevision, 0);
  if (input.fromUserId === input.toUserId) {
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_USER_INVALID', '替代人不能是原异常管理员本人');
  }
  await assertExceptionAdminMember(tx, ctx.tenantId, input.toUserId);
  const processes = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT p.id FROM approval_processes p
      JOIN approval_process_versions v ON v.tenant_id=p.tenant_id AND v.id=p.current_version_id
      WHERE p.tenant_id=${ctx.tenantId} AND p.status='active' AND v.exception_admin_user_id=${input.fromUserId}::uuid
      ORDER BY p.code LIMIT ${BATCH + 1}`),
  );
  for (const process of processes.slice(0, BATCH)) {
    await republishWithExceptionAdmin(tx, ctx, process.id, input.toUserId);
  }
  const instances = rowsOf<{ instance_id: string }>(
    await tx.execute(sql`SELECT DISTINCT t.instance_id FROM approval_tasks t
      JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id AND i.status='running'
      WHERE t.tenant_id=${ctx.tenantId} AND t.status='pending' AND t.is_exception_admin
        AND t.assignee_user_id=${input.fromUserId}::uuid
      ORDER BY t.instance_id LIMIT ${BATCH + 1}`),
  );
  let tasks = 0;
  for (const { instance_id: instanceId } of instances.slice(0, BATCH)) {
    tasks += await handoverInstance(tx, ctx, instanceId, input);
  }
  return {
    processes: Math.min(processes.length, BATCH),
    tasks,
    remaining: processes.length > BATCH || instances.length > BATCH,
  };
}

async function handoverInstance(tx: Tx, ctx: ApprovalContext, instanceId: string, input: HandoverInput) {
  const run = await openRun(tx, ctx, instanceId);
  const pending = (await loadTasks(tx, ctx.tenantId, instanceId)).filter(
    (task) => task.status === 'pending' && task.isExceptionAdmin && task.assigneeUserId === input.fromUserId,
  );
  for (const task of pending) {
    const routing = await currentRouting(tx, run, task.nodeKey);
    const successor: Candidate = {
      userId: input.toUserId,
      personId: await personOfUser(tx, ctx.tenantId, input.toUserId),
    };
    // DEC-091：替代人恰为本单发起人或异动本人时同样回避给其直线经理。
    const manager = isSelf(successor, routing.facts)
      ? await directManagerOf(tx, routing.subject, successor)
      : undefined;
    const choice = avoidSelfExceptionAdmin(successor, routing.facts, manager);
    if (choice.kind === 'unavailable') throw approvalError('CONFLICT', 'APPROVAL_EXCEPTION_ADMIN_SELF', choice.reason);
    await closeTask(tx, ctx, task.id, 'transferred', '异常管理员交接');
    const next = await insertTask(tx, ctx, instanceId, {
      round: run.instance.round,
      nodeKey: task.nodeKey,
      assigneeUserId: choice.userId,
      origin: 'handover',
      status: 'pending',
      isExceptionAdmin: true,
      parentTaskId: task.id,
    });
    await appendLog(tx, ctx, run.instance, {
      event: 'exception_admin_handover',
      nodeKey: task.nodeKey,
      taskId: next,
      detail: { fromUserId: input.fromUserId, toUserId: choice.userId, reason: choice.reason },
    });
    await notifyTodo(tx, ctx, run.instance, next, choice.userId);
  }
  run.events.push('approval.task.transferred');
  await persistRun(tx, run, 'approval.instance.handover');
  return pending.length;
}
