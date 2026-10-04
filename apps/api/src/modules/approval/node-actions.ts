/**
 * DEC-097 节点动作：抄送与审批人撤回（`14` §8.2 `isCopySend` / `isRetrieve`），开关随流程版本冻结。
 * 抄送由审批人手动选人（原站没有固定抄送对象清单），被抄送人成为参与人，只看抄送节点的表单（DEC-057）。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { isCountersign } from '@italent/domain';
import { assertOpen, ok, openTask, type Outcome } from './actions.js';
import { approvalError, assertRevision, auditApproval, type ApprovalContext } from './context.js';
import { activationOf, countersignFlowed, reopenEnded } from './countersign.js';
import { assertBusinessUnchanged, nodeIndex, openRun, persistRun } from './engine.js';
import { notifyCc } from './notifications.js';
import { isActiveAccount } from './resolver.js';
import { retrievableTask } from './rules.js';
import { appendLog, cancelPending, insertTask, instanceOfTask, loadTasks } from './store.js';

export interface CopySendInput {
  readonly taskId: string;
  readonly userIds: readonly string[];
  readonly comment: string | null;
}

export async function copySend(tx: Tx, ctx: ApprovalContext, input: CopySendInput): Promise<Outcome> {
  const scene = await openTask(tx, ctx, input.taskId);
  assertOpen(scene, ctx);
  const { run, task, node } = scene;
  if (!node.actions.copySend) throw approvalError('CONFLICT', 'APPROVAL_ACTION_DISABLED', '本节点未开启抄送');
  const userIds = [...new Set(input.userIds)];
  // 抄送对象须是有效账号（成员关系有效、全局账号未停用，R4-3）；抄送不派任务，不取派单闸。
  for (const userId of userIds) {
    if (!(await isActiveAccount(tx, ctx.tenantId, userId)))
      throw approvalError('VALIDATION_FAILED', 'APPROVAL_USER_INVALID', '抄送对象必须是本租户有效成员');
  }
  for (const userId of userIds) {
    await tx.execute(sql`INSERT INTO approval_instance_ccs
      (id,tenant_id,instance_id,node_key,task_id,user_id,comment,created_by,command_id,created_at)
      VALUES (${randomUUID()},${ctx.tenantId},${run.instance.id}::uuid,${task.nodeKey},${task.id}::uuid,
        ${userId}::uuid,${input.comment},${ctx.userId},${ctx.commandId},${ctx.now.toISOString()})`);
    await notifyCc(tx, ctx, run.instance, task.id, userId);
  }
  await appendLog(tx, ctx, run.instance, {
    event: 'cc',
    nodeKey: task.nodeKey,
    taskId: task.id,
    detail: { userIds, comment: input.comment },
  });
  await auditApproval(tx, ctx, {
    action: 'approval.instance.cc',
    objectType: 'approval-instance',
    objectId: run.instance.id,
    before: { ccUserIds: [] },
    after: { ccUserIds: userIds, nodeKey: task.nodeKey, comment: input.comment },
  });
  run.events.push('approval.instance.cc');
  await persistRun(tx, run, 'approval.instance.cc');
  return ok(run);
}

/**
 * 审批人撤回本人的同意：取消其后的待办，任务回到本人（判定见 rules.retrievableTask）。会签节点（F-003）尚未流转时
 * 只重开本人、其他人的待办不动；已沿同意流转时取消其后的待办，并恢复本节点因流转而结束的任务。
 */
export async function retrieveTask(tx: Tx, ctx: ApprovalContext, taskId: string): Promise<Outcome> {
  const run = await openRun(tx, ctx, await instanceOfTask(tx, ctx.tenantId, taskId));
  assertRevision(ctx.expectedRevision, run.instance.revision);
  assertBusinessUnchanged(run);
  const tasks = await loadTasks(tx, ctx.tenantId, run.instance.id);
  const task = tasks.find((candidate) => candidate.id === taskId)!;
  if (task.assigneeUserId !== ctx.userId)
    throw approvalError('FORBIDDEN', 'APPROVAL_NOT_ASSIGNEE', '只能撤回本人的审批');
  if (retrievableTask(run.instance, run.version, tasks, ctx.userId)?.id !== task.id) {
    throw approvalError('CONFLICT', 'APPROVAL_NOT_RETRIEVABLE', '本节点未开启撤回或后续节点已处理，不能撤回');
  }
  const activation = isCountersign(run.version.nodes[nodeIndex(run, task.nodeKey)]!) ? activationOf(tasks, task) : null;
  const flowed = activation === null || countersignFlowed(activation);
  if (flowed) await cancelPending(tx, ctx, run.instance.id);
  const reopened = await insertTask(tx, ctx, run.instance.id, {
    round: run.instance.round,
    nodeKey: task.nodeKey,
    assigneeUserId: ctx.userId,
    origin: 'retrieve',
    status: 'pending',
    isExceptionAdmin: task.isExceptionAdmin,
    parentTaskId: task.id,
    activationId: task.activationId,
  });
  if (activation && flowed) await reopenEnded(tx, run, activation, tasks);
  run.instance = { ...run.instance, currentNodeKey: task.nodeKey };
  await appendLog(tx, ctx, run.instance, { event: 'retrieve', nodeKey: task.nodeKey, taskId: reopened });
  await auditApproval(tx, ctx, {
    action: 'approval.task.retrieve',
    objectType: 'approval-instance',
    objectId: run.instance.id,
    before: { taskId: task.id, taskStatus: 'approved', currentNodeKey: run.before.currentNodeKey },
    after: { taskId: reopened, taskStatus: 'pending', currentNodeKey: task.nodeKey },
  });
  run.events.push('approval.task.retrieved');
  await persistRun(tx, run, 'approval.instance.retrieve');
  return ok(run);
}
