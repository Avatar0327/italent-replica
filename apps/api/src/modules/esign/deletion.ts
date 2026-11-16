/** F-481 §6.4：既有删除守卫放行后在同一事务撤销；已完成等终态保持历史事实。 */
import { and, eq, esignTasks } from '@italent/db';
import { registerEmployeeStatusHooks, type EmployeeStatusHooks } from '../employment/status-hooks.js';
import { applySignEvent } from './sign-events.js';

const hooks: EmployeeStatusHooks = {
  async onRecordDeleted(tx, ctx, event) {
    if (event.kind !== 'transfer') return;
    const tasks = await tx
      .select()
      .from(esignTasks)
      .where(
        and(
          eq(esignTasks.tenantId, ctx.tenantId),
          eq(esignTasks.businessId, event.recordId),
          eq(esignTasks.status, 'signing'),
        ),
      )
      .orderBy(esignTasks.id)
      .for('update');
    for (const task of tasks)
      await applySignEvent(tx, { ...ctx, expectedRevision: task.revision }, task, {
        type: 'revoked',
        cause: 'business_deleted',
        actorUserId: ctx.userId,
        at: ctx.now,
      });
  },
};
export function registerESignDeletion() {
  registerEmployeeStatusHooks('esign', hooks);
}
