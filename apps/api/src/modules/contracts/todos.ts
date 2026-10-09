import { withTenant, sql } from '@italent/db';
import { CONTRACT_OBJECT } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { isDefiniteFailure } from '../../audit/failures.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { jsonBody } from '../employment/context.js';
import { approveTask, rejectTask, disagreeTask, resubmit } from '../approval/actions.js';
import { requireResubmitRight } from '../approval/access.js';
import { loadInstance, instanceOfTask } from '../approval/store.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { rowsOf } from './context.js';
import { routeContext } from './routes.js';
import { parse } from './input.js';

/** 合并待办为逐单回执：每条单独执行原审批动作，保留自审、盲审、当前待办人和业务版本检查。 */
export function registerMergedTodos(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.post('/todos/batch', async (c) => {
    const ctx = await routeContext(c, deps, CONTRACT_OBJECT, true);
    const input = parse(
      z.strictObject({
        action: z.enum(['approve', 'decline', 'reject', 'resubmit']),
        items: z
          .array(
            z.strictObject({
              id: z.uuid(),
              revision: z.int().min(1),
              comment: z.string().max(2000).nullable().default(null),
            }),
          )
          .min(1)
          .max(100),
      }),
      await jsonBody(c),
    );
    const key = c.req.header('idempotency-key');
    if (!key || !/^[A-Za-z0-9:_-]{1,60}$/.test(key))
      throw new AppError('VALIDATION_FAILED', '批量待办须携带不超过 60 字符的命令 ID');
    const receipts = [];
    for (let i = 0; i < input.items.length; i++) {
      const item = input.items[i]!;
      try {
        const instanceId =
          input.action === 'resubmit'
            ? item.id
            : await withTenant(deps.db, ctx.tenantId, (tx) => instanceOfTask(tx, ctx.tenantId, item.id));
        const instance = await withTenant(deps.db, ctx.tenantId, (tx) => loadInstance(tx, ctx.tenantId, instanceId));
        if (instance.businessType !== 'contract') throw new AppError('NOT_FOUND', '合同待办不存在');
        if (input.action === 'resubmit') await requireResubmitRight(deps, ctx, instanceId);
        else {
          const [task] = await withTenant(deps.db, ctx.tenantId, async (tx) =>
            rowsOf(
              await tx.execute(sql`
            SELECT id FROM approval_tasks WHERE tenant_id=${ctx.tenantId} AND id=${item.id}::uuid
        AND assignee_user_id=${ctx.userId}::uuid`),
            ),
          );
          if (!task) throw new AppError('FORBIDDEN', '只有当前审批人可以处理该任务');
        }
        const result = await runCommand(deps.db, ctx, {
          id: `${key}:${i}`,
          fingerprint: { input, index: i },
          execute: async (tx, commandId) => {
            const context = {
              ...ctx,
              scope: undefined,
              commandId,
              expectedRevision: item.revision,
              authorize: authorizeInTransaction(deps.authorize, tx),
              recheckContractResubmit: (
                tx: Parameters<typeof resubmit>[0],
                id: string,
                corrections: Record<string, unknown>,
              ) => requireResubmitRight(deps, ctx, id, corrections, tx),
            };
            if (input.action === 'resubmit') return resubmit(tx, context, instanceId);
            const viewable = await ctx.fields!.viewable(tx, ctx.userId, CONTRACT_OBJECT);
            const decision = { taskId: item.id, comment: item.comment };
            return input.action === 'approve'
              ? approveTask(tx, context, decision, viewable)
              : input.action === 'decline'
                ? disagreeTask(tx, context, decision, viewable)
                : rejectTask(tx, context, decision, viewable);
          },
        });
        receipts.push({ id: item.id, status: result.status, result: result.body });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        receipts.push({ id: item.id, status: error.status, error: receiptError(error) });
      }
    }
    return c.json({ items: receipts });
  });
}

/** 结果未知 / 存储不可写也逐条回执，但带机器可读原因，客户端按原命令 ID 回查（PR #75 第二轮 P2-8）。 */
export function receiptError(error: AppError, _entitled = false) {
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  return { code: error.code, message: error.message, ...(isDefiniteFailure(error) ? {} : { reason }) };
}
