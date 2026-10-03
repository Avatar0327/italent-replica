/**
 * 加签任务链（DEC-095，`14` §11.4 单人审批节点）：一次加签可选多人，按选择顺序依次审批——第一位立即派待办，
 * 其余排队（queued）。前加签全部同意后回到原审批人；后加签（原审批人已同意）全部完成才离开本节点。
 */
import type { Tx } from '@italent/db';
import { approvalError } from './context.js';
import { afterNodeApproved, type Run } from './engine.js';
import { notifyTodo } from './notifications.js';
import { addSignLink } from './rules.js';
import { activateTask, appendLog, insertTask, loadTasks, type TaskRow } from './store.js';

/** `14` §11.3：节点同时配置加签时，只有本节点原审批人能编辑表单，加签人不能。 */
export function assertNotAddSigner(tasks: readonly TaskRow[], task: TaskRow): void {
  if (addSignLink(tasks, task)) {
    throw approvalError('FORBIDDEN', 'APPROVAL_ADD_SIGNER_EDIT', '加签人不能编辑表单内容，只有本节点原审批人可以');
  }
}

/** 同意之后的去向：轮到排队中的下一位加签人 → 前加签回到原审批人 → 本节点已无待办则推进到下一节点。 */
export async function continueAfterApproval(tx: Tx, run: Run, approved: TaskRow): Promise<void> {
  const tasks = await loadTasks(tx, run.ctx.tenantId, run.instance.id);
  const link = addSignLink(tasks, approved);
  if (link) {
    const next = tasks.find(
      (task) => task.status === 'queued' && task.parentTaskId === link.signerTaskId && task.origin === link.origin,
    );
    if (next) return activateNext(tx, run, next);
    if (link.origin === 'add_sign_before') return returnToSigner(tx, run, tasks, link.signerTaskId, approved);
  }
  await afterNodeApproved(tx, run, approved.nodeKey, tasks);
}

async function activateNext(tx: Tx, run: Run, next: TaskRow): Promise<void> {
  await activateTask(tx, run.ctx, run.instance.id, next.id);
  await appendLog(tx, run.ctx, run.instance, {
    event: 'add_sign_next',
    nodeKey: next.nodeKey,
    taskId: next.id,
    detail: { toUserId: next.assigneeUserId },
  });
  await notifyTodo(tx, run.ctx, run.instance, next.id, next.assigneeUserId!);
}

/** 前加签人全部同意后，给发起加签的原审批人新建本节点待办。 */
async function returnToSigner(
  tx: Tx,
  run: Run,
  tasks: readonly TaskRow[],
  signerTaskId: string,
  approved: TaskRow,
): Promise<void> {
  const signer = tasks.find((candidate) => candidate.id === signerTaskId);
  if (!signer?.assigneeUserId) throw approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_TASK_CHAIN', '加签任务链不完整');
  const next = await insertTask(tx, run.ctx, run.instance.id, {
    round: run.instance.round,
    nodeKey: approved.nodeKey,
    assigneeUserId: signer.assigneeUserId,
    origin: 'add_sign_return',
    status: 'pending',
    isExceptionAdmin: signer.isExceptionAdmin,
    parentTaskId: approved.id,
  });
  await appendLog(tx, run.ctx, run.instance, {
    event: 'add_sign_return',
    nodeKey: approved.nodeKey,
    taskId: next,
    detail: { toUserId: signer.assigneeUserId },
  });
  await notifyTodo(tx, run.ctx, run.instance, next, signer.assigneeUserId);
}
