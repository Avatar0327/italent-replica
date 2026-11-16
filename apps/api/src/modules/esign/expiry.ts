/** F-481 §5.2 / §5.4：确认与 S3c 调度共用；锁后判定，重复执行不再写审计。 */
import { and, eq, esignTasks, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { EmploymentContext } from '../employment/types.js';
import { applySignEvent } from './sign-events.js';

export async function expireSignTask(tx: Tx, ctx: EmploymentContext, id: string) {
  const [task] = await tx
    .select()
    .from(esignTasks)
    .where(and(eq(esignTasks.tenantId, ctx.tenantId), eq(esignTasks.id, id)))
    .for('update');
  if (!task) throw new AppError('NOT_FOUND', '签署任务不存在');
  if (task.status !== 'signing' || ctx.now.getTime() < task.expiresAt.getTime()) return task;
  return applySignEvent(tx, ctx, task, { type: 'expired', at: ctx.now });
}
