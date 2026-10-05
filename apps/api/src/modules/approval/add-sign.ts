/**
 * 加签任务链（DEC-095，`14` §11.4 单人审批节点）：一次加签可选多人，按选择顺序依次审批——第一位立即派待办，
 * 其余排队（queued）。前加签全部同意后回到原审批人；后加签（原审批人已同意）全部完成才离开本节点。
 * 会签节点的并加签人与原审批人同时审批、计入流转规则（F-003 / DEC-144），同意后按会签结算（countersign.ts）；会签
 * 节点的前加签（DEC-152）按席位生效：前加签人依次先审、不计入流转规则，全部同意后回到原席位审批人。
 * 嵌套加签在入口拒绝（rules.addSignAllowed，F5）。
 */
import type { Tx } from '@italent/db';
import { isCountersign } from '@italent/domain';
import { approvalError } from './context.js';
import { mergeSeat, mergesSeat, resettle, settleCountersign } from './countersign.js';
import { afterNodeApproved, currentRouting, exceptionAdminFor, nodeIndex, type Run } from './engine.js';
import { notifyTodo } from './notifications.js';
import { isEligibleApprover } from './resolver.js';
import { addSignLink, type AddSignLink } from './rules.js';
import {
  activateTask,
  appendLog,
  closeAddSigned,
  closeQueued,
  insertTask,
  loadTasks,
  resumeAddSigned,
  type TaskRow,
} from './store.js';

/** `14` §11.3：节点同时配置加签时，只有本节点原审批人能编辑表单，加签人不能。 */
export function assertNotAddSigner(tasks: readonly TaskRow[], task: TaskRow): void {
  if (addSignLink(tasks, task)) {
    throw approvalError('FORBIDDEN', 'APPROVAL_ADD_SIGNER_EDIT', '加签人不能编辑表单内容，只有本节点原审批人可以');
  }
}

/**
 * 同意之后的去向：会签节点的前加签人轮到下一位或回到原席位，其余按流转规则结算（F-003 / DEC-152）；单人节点轮到
 * 排队中的下一位加签人 → 前加签回到原审批人 → 本节点已无待办则推进到下一节点。
 */
export async function continueAfterApproval(tx: Tx, run: Run, approved: TaskRow): Promise<void> {
  const node = run.version.nodes[nodeIndex(run, approved.nodeKey)]!;
  const tasks = await loadTasks(tx, run.ctx.tenantId, run.instance.id);
  const link = addSignLink(tasks, approved);
  if (isCountersign(node)) {
    if (link?.origin === 'add_sign_before') return continueBeforeChain(tx, run, tasks, link);
    return settleCountersign(tx, run, node, approved);
  }
  if (link) {
    const next = tasks.find(
      (task) => task.status === 'queued' && task.parentTaskId === link.signerTaskId && task.origin === link.origin,
    );
    if (next) return activateNext(tx, run, next);
    if (link.origin === 'add_sign_before') return returnToSigner(tx, run, tasks, link.signerTaskId, approved);
  }
  await afterNodeApproved(tx, run, approved.nodeKey, tasks);
}

/**
 * F8：轮到排队中的加签人时先复核其资格（DEC-054 / DEC-098）；已停用或已离职即转异常管理员。接替任务挂在原排队
 * 任务下（rules.addSignLink 仍认得这条链），之后的排队加签人与返回原审批人照常进行，原链义务不丢失。
 */
async function activateNext(tx: Tx, run: Run, next: TaskRow): Promise<void> {
  const routing = await currentRouting(tx, run, next.nodeKey);
  if (await isEligibleApprover(tx, routing.subject, next.assigneeUserId!)) {
    await activateTask(tx, run.ctx, run.instance.id, next.id);
    await appendLog(tx, run.ctx, run.instance, {
      event: 'add_sign_next',
      nodeKey: next.nodeKey,
      taskId: next.id,
      detail: { toUserId: next.assigneeUserId },
    });
    await notifyTodo(tx, run.ctx, run.instance, next.id, next.assigneeUserId!);
    return;
  }
  await closeQueued(tx, run.ctx, next.id);
  await handToExceptionAdmin(tx, run, next, next.id);
}

/**
 * 前加签人全部同意后，给发起加签的原审批人新建本节点待办；原审批人已不可审批时转异常管理员（F8），
 * 接替任务挂在原审批人任务下、不在加签链上，同意即离开本节点。
 */
async function returnToSigner(
  tx: Tx,
  run: Run,
  tasks: readonly TaskRow[],
  signerTaskId: string,
  approved: TaskRow,
): Promise<void> {
  const signer = tasks.find((candidate) => candidate.id === signerTaskId);
  if (!signer?.assigneeUserId) throw approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_TASK_CHAIN', '加签任务链不完整');
  const routing = await currentRouting(tx, run, approved.nodeKey);
  if (!(await isEligibleApprover(tx, routing.subject, signer.assigneeUserId))) {
    return handToExceptionAdmin(tx, run, signer, signer.id);
  }
  const next = await insertTask(tx, run.ctx, run.instance.id, {
    round: run.instance.round,
    nodeKey: approved.nodeKey,
    assigneeUserId: signer.assigneeUserId,
    origin: 'add_sign_return',
    status: 'pending',
    isExceptionAdmin: signer.isExceptionAdmin,
    parentTaskId: approved.id,
    activationId: approved.activationId,
  });
  await appendLog(tx, run.ctx, run.instance, {
    event: 'add_sign_return',
    nodeKey: approved.nodeKey,
    taskId: next,
    detail: { toUserId: signer.assigneeUserId },
  });
  await notifyTodo(tx, run.ctx, run.instance, next, signer.assigneeUserId);
}

/** 会签节点前加签人同意之后（DEC-152）：轮到排队中的下一位；全部同意则回到原席位，这一席仍由原审批人投票。 */
async function continueBeforeChain(tx: Tx, run: Run, tasks: readonly TaskRow[], link: AddSignLink) {
  const next = tasks.find(
    (task) => task.status === 'queued' && task.parentTaskId === link.signerTaskId && task.origin === link.origin,
  );
  if (next) return activateNext(tx, run, next);
  const seat = tasks.find((candidate) => candidate.id === link.signerTaskId);
  if (seat?.status !== 'add_signed' || !seat.assigneeUserId) {
    throw approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_TASK_CHAIN', '加签任务链不完整');
  }
  const routing = await currentRouting(tx, run, seat.nodeKey);
  if (await isEligibleApprover(tx, routing.subject, seat.assigneeUserId)) {
    // 回到原席位：原审批人挂起的任务恢复为待办，这一席始终只有一张任务。
    await resumeAddSigned(tx, run.ctx, run.instance.id, seat.id);
    await appendLog(tx, run.ctx, run.instance, {
      event: 'add_sign_return',
      nodeKey: seat.nodeKey,
      taskId: seat.id,
      detail: { toUserId: seat.assigneeUserId },
    });
    return notifyTodo(tx, run.ctx, run.instance, seat.id, seat.assigneeUserId);
  }
  // 原审批人已不可审批（F8）：这一席转异常管理员；异常管理员已在本节点占着一席时合并（一人一票）。
  await closeAddSigned(tx, run.ctx, seat.id);
  const admin = await exceptionAdminFor(tx, run, routing.subject, routing.facts);
  if (!mergesSeat(run, tasks, seat, admin.userId)) return handToExceptionAdmin(tx, run, seat, seat.id);
  await mergeSeat(tx, run, seat, admin.userId, 'exception_admin');
  await resettle(tx, run, seat);
}

async function handToExceptionAdmin(tx: Tx, run: Run, replaced: TaskRow, parentTaskId: string): Promise<void> {
  const routing = await currentRouting(tx, run, replaced.nodeKey);
  const admin = await exceptionAdminFor(tx, run, routing.subject, routing.facts);
  const next = await insertTask(tx, run.ctx, run.instance.id, {
    round: run.instance.round,
    nodeKey: replaced.nodeKey,
    assigneeUserId: admin.userId,
    origin: 'exception_admin',
    status: 'pending',
    isExceptionAdmin: true,
    parentTaskId,
    activationId: replaced.activationId,
  });
  await appendLog(tx, run.ctx, run.instance, {
    event: 'add_sign_exception_admin',
    nodeKey: replaced.nodeKey,
    taskId: next,
    actorUserId: null,
    detail: {
      fromUserId: replaced.assigneeUserId,
      toUserId: admin.userId,
      reason: `审批人已不可审批；${admin.reason}`,
    },
  });
  await notifyTodo(tx, run.ctx, run.instance, next, admin.userId);
  run.events.push('approval.task.transferred');
}
