/** F-481 §4.3/6.3：逐条回执，只捕获明确业务拒绝；存储/通知失败整条事务回滚。 */
import { and, desc, eq, esignTasks, sql, type Tx } from '@italent/db';
import { ESIGN_REMIND_TEMPLATE, ESIGN_NOTICE_BUSINESS_TYPE } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import type { ModuleScope } from '../permission/module-access.js';
import { auditEmployment } from '../employment/context.js';
import { notifyMessage } from '../approval/notifications.js';
import { applySignEvent, type SignTask } from './sign-events.js';
import { simulatedProvider } from './provider.js';
import { reminderPayload } from './notice-payload.js';
import { signTaskSourceAudit } from './task-source.js';
import { presentRecord, recordScope, loadVisibleSignTask } from './record-access.js';

export interface RecordQuery {
  tab: 'all' | 'signing' | 'completed';
  page: number;
  pageSize: number;
}
export interface RecordItem {
  id: string;
  revision: number;
}
export interface Receipt {
  id: string;
  ok: boolean;
  code?: string;
}
export async function listRecords(
  tx: Tx,
  ctx: ScopeBusinessContext,
  scope: ModuleScope,
  fields: ReadonlySet<string> | undefined,
  query: RecordQuery,
) {
  const where = and(
    eq(esignTasks.tenantId, ctx.tenantId),
    recordScope(scope),
    query.tab === 'all' ? undefined : eq(esignTasks.status, query.tab),
  );
  const [count] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(esignTasks)
    .where(where);
  const tasks = await tx
    .select()
    .from(esignTasks)
    .where(where)
    .orderBy(desc(esignTasks.initiatedAt), desc(esignTasks.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const items = [];
  for (const task of tasks) items.push(await presentRecord(tx, ctx, task, fields));
  return { items, total: count!.total, page: query.page, pageSize: query.pageSize };
}

export async function remindTask(tx: Tx, ctx: ScopeBusinessContext, task: SignTask) {
  const node = task.currentNode as 'employee' | 'enterprise';
  const recipient = node === 'employee' ? task.employeeSignerUserId : task.initiatorUserId;
  if (!recipient) throw new AppError('CONFLICT', '签署任务不允许此操作', { reason: 'ESIGN_TASK_CLOSED' });
  await simulatedProvider.remind({ tenantId: ctx.tenantId, taskId: task.id, providerRef: task.providerRef, node });
  await notifyMessage(
    tx,
    ctx,
    { businessType: ESIGN_NOTICE_BUSINESS_TYPE, businessId: task.id },
    {
      recipientUserId: recipient,
      templateCode: ESIGN_REMIND_TEMPLATE,
      payload: await reminderPayload(tx, ctx.tenantId, task, () =>
        new Intl.DateTimeFormat('zh-CN', {
          timeZone: ctx.timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(task.expiresAt),
      ),
    },
  );
  await auditEmployment(
    tx,
    ctx,
    'esign.task.reminded',
    'esign-task',
    task.id,
    null,
    { ...signTaskSourceAudit(task), recipientUserId: recipient, method: 'manual' },
    undefined,
    undefined,
    { employeeId: task.employeeId, orgId: task.ownerDepartmentId },
  );
}

export async function actOnRecords(
  tx: Tx,
  ctx: ScopeBusinessContext,
  scope: ModuleScope,
  items: RecordItem[],
  action: 'remind' | 'revoke',
) {
  const results = new Map<string, Receipt>();
  // 锁顺序稳定，交叠批次不会因客户端条目顺序相反而死锁；回执仍保持输入顺序。
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    try {
      await tx.transaction(async (savepoint) => {
        const task = await loadVisibleSignTask(savepoint, ctx, item.id, scope, true);
        if (task.revision !== item.revision) throw new AppError('REVISION_CONFLICT', '签署任务已变更');
        if (task.status !== 'signing')
          throw new AppError('CONFLICT', '签署任务不允许此操作', { reason: 'ESIGN_TASK_CLOSED' });
        if (action === 'revoke')
          await applySignEvent(savepoint, ctx, task, {
            type: 'revoked',
            cause: 'manual',
            actorUserId: ctx.userId,
            at: ctx.now,
          });
        else await remindTask(savepoint, ctx, task);
      });
      results.set(item.id, { id: item.id, ok: true });
    } catch (error) {
      if (!(error instanceof AppError) || !['NOT_FOUND', 'REVISION_CONFLICT', 'CONFLICT'].includes(error.code))
        throw error;
      const reason = (error.details as { reason?: string } | undefined)?.reason;
      results.set(item.id, { id: item.id, ok: false, code: reason ?? error.code });
    }
  }
  return { items: items.map((item) => results.get(item.id)!) };
}

/** 包含失败回执在内逐项复核，不把历史成功/失败状态交给已经失去范围的用户。 */
export async function trimReceipts(tx: Tx, ctx: ScopeBusinessContext, scope: ModuleScope, body: { items: Receipt[] }) {
  const items = [];
  for (const receipt of body.items) {
    try {
      await loadVisibleSignTask(tx, ctx, receipt.id, scope);
      items.push(receipt);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'NOT_FOUND') throw error;
      items.push({ id: receipt.id, ok: false, code: 'NOT_FOUND' });
    }
  }
  return { items };
}
