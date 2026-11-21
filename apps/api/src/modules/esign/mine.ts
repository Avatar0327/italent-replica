/** F-481 §5.2 / §8.3 / §10：签署人拥有整份快照的查看权，不继承 HR 任职/签署记录字段权限。 */
import { and, eq, inArray, desc, esignTasks, esignTaskFiles, type Tx } from '@italent/db';
import { or, isNotNull } from 'drizzle-orm';
import { isEsignFailureReason } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { EmploymentContext } from '../employment/types.js';
import { withActorNames } from '../approval/store.js';
import { applySignEvent, type SignTask } from './sign-events.js';
import { expireSignTask } from './expiry.js';

export function signerPredicate(userId: string) {
  return or(eq(esignTasks.employeeSignerUserId, userId), eq(esignTasks.initiatorUserId, userId));
}

export async function ownSignTask(tx: Tx, ctx: EmploymentContext, id: string, lock = false) {
  const query = tx
    .select()
    .from(esignTasks)
    .where(and(eq(esignTasks.tenantId, ctx.tenantId), eq(esignTasks.id, id), signerPredicate(ctx.userId)));
  const [task] = await (lock ? query.for('update') : query);
  if (!task) throw new AppError('NOT_FOUND', '签署任务不存在');
  return task;
}

export function signReceipt(task: SignTask) {
  return {
    id: task.id,
    revision: task.revision,
    status: task.status,
    currentNode: task.currentNode,
    employeeSignedAt: task.employeeSignedAt?.toISOString() ?? null,
    enterpriseSignedAt: task.enterpriseSignedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
  };
}

async function mineViews(tx: Tx, ctx: EmploymentContext, tasks: SignTask[], detail: boolean) {
  if (!tasks.length) return [];
  // 文件仅查询已通过 own 判定的任务；列表不读取正文，每页至多 100 个任务。
  const files = await tx
    .select({
      taskId: esignTaskFiles.taskId,
      seq: esignTaskFiles.seq,
      templateId: esignTaskFiles.templateId,
      templateName: esignTaskFiles.templateName,
      ...(detail ? { content: esignTaskFiles.content } : {}),
    })
    .from(esignTaskFiles)
    .where(
      and(
        eq(esignTaskFiles.tenantId, ctx.tenantId),
        inArray(
          esignTaskFiles.taskId,
          tasks.map((t) => t.id),
        ),
      ),
    )
    .orderBy(esignTaskFiles.seq);
  const actors = await withActorNames(
    tx,
    tasks.map((t) => ({ actorUserId: t.initiatorUserId })),
  );
  return tasks.map((task, index) => ({
    ...signReceipt(task),
    scene: task.scene,
    initiator: { id: task.initiatorUserId, name: actors[index]!.actorName },
    initiatedAt: task.initiatedAt.toISOString(),
    expiresAt: task.expiresAt.toISOString(),
    canSign: task.status === 'signing' && ctx.now < task.expiresAt && currentSigner(task) === ctx.userId,
    files: files.filter((f) => f.taskId === task.id).map(({ taskId: _taskId, ...file }) => file),
    ...(detail
      ? {
          ...(task.status === 'failed' && isEsignFailureReason(task.failureReason)
            ? { failureReason: task.failureReason }
            : {}),
          nodes: [
            {
              node: 'employee',
              userId: task.employeeSignerUserId,
              signedAt: task.employeeSignedAt?.toISOString() ?? null,
            },
            {
              node: 'enterprise',
              userId: task.initiatorUserId,
              signedAt: task.enterpriseSignedAt?.toISOString() ?? null,
            },
          ],
        }
      : {}),
  }));
}

export async function listMine(
  tx: Tx,
  ctx: EmploymentContext,
  query: { tab: 'pending' | 'done'; limit: number; offset: number },
) {
  const mine =
    query.tab === 'pending'
      ? and(
          eq(esignTasks.status, 'signing'),
          or(
            and(eq(esignTasks.currentNode, 'employee'), eq(esignTasks.employeeSignerUserId, ctx.userId)),
            and(eq(esignTasks.currentNode, 'enterprise'), eq(esignTasks.initiatorUserId, ctx.userId)),
          ),
        )
      : or(
          and(eq(esignTasks.employeeSignerUserId, ctx.userId), isNotNull(esignTasks.employeeSignedAt)),
          and(eq(esignTasks.initiatorUserId, ctx.userId), isNotNull(esignTasks.enterpriseSignedAt)),
        );
  const tasks = await tx
    .select()
    .from(esignTasks)
    .where(and(eq(esignTasks.tenantId, ctx.tenantId), signerPredicate(ctx.userId), mine))
    .orderBy(desc(esignTasks.initiatedAt), esignTasks.id)
    .limit(query.limit)
    .offset(query.offset);
  return { items: await mineViews(tx, ctx, tasks, false) };
}

export async function mineDetail(tx: Tx, ctx: EmploymentContext, id: string) {
  return (await mineViews(tx, ctx, [await ownSignTask(tx, ctx, id)], true))[0]!;
}

function currentSigner(task: SignTask) {
  return task.currentNode === 'employee' ? task.employeeSignerUserId : task.initiatorUserId;
}

export async function signMine(tx: Tx, ctx: EmploymentContext, id: string, clock: () => Date) {
  const task = await ownSignTask(tx, ctx, id, true);
  if (task.revision !== ctx.expectedRevision) throw new AppError('REVISION_CONFLICT', '签署任务已变更，请刷新后重试');
  if (task.status !== 'signing') throw new AppError('CONFLICT', '签署任务已结束', { reason: 'ESIGN_TASK_CLOSED' });
  if (currentSigner(task) !== ctx.userId)
    throw new AppError('CONFLICT', '尚未轮到您签署', { reason: 'ESIGN_NODE_NOT_READY' });
  // 请求可能等过命令守卫或行锁；拿锁后重取服务端时间，不能用请求开始时的过期判据。
  const eventCtx = { ...ctx, now: clock() };
  const current = await expireSignTask(tx, eventCtx, id);
  // 409 作为已提交回执入台账；不能抛异常，否则新写的 expired 与审计会被回滚。
  if (current.status === 'expired')
    return {
      status: 409 as const,
      body: { error: { code: 'CONFLICT', message: '签署任务已过期', details: { reason: 'ESIGN_TASK_EXPIRED' } } },
    };
  const updated = await applySignEvent(tx, eventCtx, current, {
    type: 'node_signed',
    node: current.currentNode as 'employee' | 'enterprise',
    actorUserId: ctx.userId,
    at: eventCtx.now,
  });
  return { status: 200 as const, body: signReceipt(updated) };
}
