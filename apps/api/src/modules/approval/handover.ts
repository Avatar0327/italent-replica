/**
 * 异常管理员交接（DEC-098）：异常管理员停用前必须指定替代人——引用其为异常管理员的流程以当前版本为底稿重新发布，
 * 其名下在办的异常任务转给替代人；之后才允许撤销其成员关系（迁移 0030 触发器把关）。
 * 已在途实例冻结在旧版本，旧异常管理员停用后新产生的异常任务由租户管理员接管（engine.exceptionAdminFor）。
 * F2：替换流程配置只需流程配置权（DEC-102）；改派在途实例是实例干预，逐单复核操作人的实例转交按钮与数据范围，
 * 以及 DEC-092 本人回避，不满足的实例跳过并在结果里列出原因，由其他管理员处理。
 */
import { sql, type Tx } from '@italent/db';
import { avoidSelfExceptionAdmin, isSelf, type Candidate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { approvalError, assertRevision, rowsOf, type ApprovalContext } from './context.js';
import { assertExceptionAdminMember, republishWithExceptionAdmin } from './definitions.js';
import { currentRouting, openRun, persistRun, type Run } from './engine.js';
import { notifyTodo } from './notifications.js';
import { directManagerOf, personOfUser, userOfPerson } from './resolver.js';
import { isOwnRequest } from './rules.js';
import { appendLog, closeTask, insertTask, loadInstance, loadTasks, type TaskRow } from './store.js';

/** 单次交接的规模上限（DEC-101：只限制单次操作规模），超出时返回 remaining，由管理员再次提交。 */
const BATCH = 200;

export interface HandoverInput {
  readonly fromUserId: string;
  readonly toUserId: string;
}

export interface SkippedInstance {
  readonly instanceId: string;
  readonly reason: string;
}

/**
 * @param scope 操作人的实例转交权限（实例转交按钮 + 数据范围，对 approval_instances 别名 i）；没有按钮时为 null
 */
export async function handoverExceptionAdmin(tx: Tx, ctx: ApprovalContext, input: HandoverInput, scope: SQL | null) {
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
  const skipped: SkippedInstance[] = [];
  for (const { instance_id: instanceId } of instances.slice(0, BATCH)) {
    const blocked = await instanceBlocker(tx, ctx, instanceId, scope);
    const outcome = blocked ?? (await handoverInstance(tx, ctx, instanceId, input));
    if (typeof outcome === 'number') tasks += outcome;
    else skipped.push({ instanceId, reason: outcome });
  }
  return {
    processes: Math.min(processes.length, BATCH),
    tasks,
    skipped,
    remaining: processes.length > BATCH || instances.length > BATCH,
  };
}

/** 与管理员转交入口相同的实例级检查（actions.adminAct）：按钮、数据范围、本人回避。 */
async function instanceBlocker(tx: Tx, ctx: ApprovalContext, instanceId: string, scope: SQL | null) {
  if (!scope) return 'APPROVAL_ADMIN_REQUIRED';
  const [covered] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM approval_instances i WHERE i.tenant_id=${ctx.tenantId}
      AND i.id=${instanceId}::uuid AND ${scope}`),
  );
  if (!covered) return 'APPROVAL_SCOPE_DENIED';
  const instance = await loadInstance(tx, ctx.tenantId, instanceId);
  const subjectUserId = await userOfPerson(tx, ctx.tenantId, instance.subjectEmployeeId);
  return isOwnRequest(instance, subjectUserId, ctx.userId) ? 'APPROVAL_ADMIN_SELF' : null;
}

/** @returns 改派的任务数；替代人本人回避后无人接替时返回原因，整单不动 */
async function handoverInstance(tx: Tx, ctx: ApprovalContext, instanceId: string, input: HandoverInput) {
  const run = await openRun(tx, ctx, instanceId);
  const pending = (await loadTasks(tx, ctx.tenantId, instanceId)).filter(
    (task) => task.status === 'pending' && task.isExceptionAdmin && task.assigneeUserId === input.fromUserId,
  );
  const plan: { task: TaskRow; userId: string; reason: string }[] = [];
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
    if (choice.kind === 'unavailable') return 'APPROVAL_EXCEPTION_ADMIN_SELF';
    plan.push({ task, userId: choice.userId, reason: choice.reason });
  }
  for (const step of plan) await reassign(tx, run, step, input.fromUserId);
  run.events.push('approval.task.transferred');
  await persistRun(tx, run, 'approval.instance.handover');
  return plan.length;
}

async function reassign(tx: Tx, run: Run, step: { task: TaskRow; userId: string; reason: string }, from: string) {
  const { ctx, instance } = run;
  await closeTask(tx, ctx, step.task.id, 'transferred', '异常管理员交接');
  const next = await insertTask(tx, ctx, instance.id, {
    round: instance.round,
    nodeKey: step.task.nodeKey,
    assigneeUserId: step.userId,
    origin: 'handover',
    status: 'pending',
    isExceptionAdmin: true,
    parentTaskId: step.task.id,
  });
  await appendLog(tx, ctx, instance, {
    event: 'exception_admin_handover',
    nodeKey: step.task.nodeKey,
    taskId: next,
    detail: { fromUserId: from, toUserId: step.userId, reason: step.reason },
  });
  await notifyTodo(tx, ctx, instance, next, step.userId);
}
