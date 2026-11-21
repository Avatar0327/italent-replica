/** F-481 §5.1 / §6.3：状态、审计 / outbox 与通知同事务。调用方负责提交命令及过期时机判定。 */
import { and, eq, esignTasks, esignTaskFiles, sql, type Tx } from '@italent/db';
import {
  nextSignState,
  esignFileLabel,
  ESIGN_SCENE_LABEL,
  ESIGN_NOTICE_BUSINESS_TYPE,
  ESIGN_COMPLETED_EMPLOYEE_TEMPLATE,
  ESIGN_COMPLETED_INITIATOR_TEMPLATE,
  ESIGN_REVOKED_EMPLOYEE_TEMPLATE,
  ESIGN_REVOKED_INITIATOR_TEMPLATE,
  type SignEvent,
  type SignTaskState,
} from '@italent/domain';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { AppError } from '../../errors.js';
import { personnelHooks } from '../employment/personnel-hooks.js';
import { auditEmployment } from '../employment/context.js';
import type { EmploymentContext } from '../employment/types.js';
import { rowsOf } from '../employment/record-store.js';
import { notifyMessage } from '../approval/notifications.js';
import { simulatedProvider } from './provider.js';
import { minimalSignNotice } from './notice-payload.js';
import { signTaskSourceAudit } from './task-source.js';

export type SignTask = typeof esignTasks.$inferSelect;

/** 锁后重读，不使用调用方的状态快照决策；旧 revision 不得覆盖已确认 / 撤销的任务。 */
export async function applySignEvent(
  tx: Tx,
  ctx: EmploymentContext,
  expected: Pick<SignTask, 'id' | 'revision'>,
  event: SignEvent,
): Promise<SignTask> {
  const where = and(eq(esignTasks.tenantId, ctx.tenantId), eq(esignTasks.id, expected.id));
  const [task] = await tx.select().from(esignTasks).where(where).for('update');
  if (!task) throw new AppError('NOT_FOUND', '签署任务不存在');
  if (task.revision !== expected.revision) throw new AppError('REVISION_CONFLICT', '签署任务已变更');
  const next = nextSignState(task as SignTaskState, event);
  if (!next.ok) throw new AppError('CONFLICT', '签署任务不允许此操作', { reason: next.reason });
  const patch: Partial<SignTask> = {
    status: next.status,
    currentNode: next.currentNode,
    revision: task.revision + 1,
    updatedAt: event.at,
  };
  if (event.type === 'node_signed') {
    if (event.node === 'employee') patch.employeeSignedAt = event.at;
    else {
      patch.enterpriseSignedAt = event.at;
      patch.completedAt = event.at;
    }
  } else if (event.type === 'revoked') {
    Object.assign(patch, { revokedAt: event.at, revokedBy: event.actorUserId, revokeCause: event.cause });
  } else if (event.type === 'expired') patch.expiredAt = event.at;
  else patch.failureReason = event.reason;
  const [updated] = await tx.update(esignTasks).set(patch).where(where).returning();
  const actor = 'actorUserId' in event ? event.actorUserId : null;
  const auditCtx = { ...ctx, now: event.at, userId: actor ?? SYSTEM_USER_ID };
  const audit = (action: string, after: object) =>
    auditEmployment(
      tx,
      auditCtx,
      action,
      'esign-task',
      task.id,
      { status: task.status, currentNode: task.currentNode },
      after,
      undefined,
      undefined,
      { employeeId: task.employeeId, orgId: task.ownerDepartmentId },
    );
  const after = { status: next.status, currentNode: next.currentNode, ...signTaskSourceAudit(task) };
  if (event.type === 'node_signed') {
    await audit('esign.task.node_signed', { ...after, node: event.node, actorUserId: event.actorUserId });
    if (next.status === 'completed') await audit('esign.task.completed', after);
  } else if (event.type === 'revoked') await audit('esign.task.revoked', { ...after, revoke_cause: event.cause });
  else if (event.type === 'expired') await audit('esign.task.expired', after);
  else await audit('esign.task.failed', { ...after, failure_reason: event.reason });
  if (next.status === 'revoked' || next.status === 'expired')
    await simulatedProvider.revoke({ tenantId: ctx.tenantId, taskId: task.id, providerRef: task.providerRef });
  if (next.status === 'completed' || next.status === 'revoked') await terminalNotices(tx, auditCtx, updated!);
  return updated!;
}

async function terminalNotices(tx: Tx, ctx: EmploymentContext, task: SignTask) {
  const payload = minimalSignNotice(task) ?? (await transferTerminalPayload(tx, ctx, task));
  const completed = task.status === 'completed';
  const target = { businessType: ESIGN_NOTICE_BUSINESS_TYPE, businessId: task.id };
  if (task.employeeSignerUserId)
    await notifyMessage(tx, ctx, target, {
      recipientUserId: task.employeeSignerUserId,
      templateCode: completed ? ESIGN_COMPLETED_EMPLOYEE_TEMPLATE : ESIGN_REVOKED_EMPLOYEE_TEMPLATE,
      payload,
    });
  await notifyMessage(tx, ctx, target, {
    recipientUserId: task.initiatorUserId,
    templateCode: completed ? ESIGN_COMPLETED_INITIATOR_TEMPLATE : ESIGN_REVOKED_INITIATOR_TEMPLATE,
    payload,
  });
}

async function transferTerminalPayload(tx: Tx, ctx: EmploymentContext, task: SignTask) {
  const files = await tx
    .select()
    .from(esignTaskFiles)
    .where(and(eq(esignTaskFiles.tenantId, ctx.tenantId), eq(esignTaskFiles.taskId, task.id)))
    .orderBy(esignTaskFiles.seq);
  const [employee] = rowsOf<{ name: string }>(
    await tx.execute(sql`SELECT ${personnelHooks.currentName(ctx.tenantId, sql`e.id`, sql`e.name`)} AS name
    FROM employment_employees e
    WHERE e.tenant_id=${ctx.tenantId} AND e.id=${task.employeeId}::uuid`),
  );
  return {
    场景: ESIGN_SCENE_LABEL,
    文件名称: esignFileLabel(files.map((f) => f.templateName)),
    员工姓名: employee?.name ?? '--',
  };
}
