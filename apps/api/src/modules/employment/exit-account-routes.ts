/** F-261：配置、持久待办及原任务授权重试；每次台账重放均按当前权限再判。 */
import { and, eq, exitAccountTasks, sql, withTenant, type Tx } from '@italent/db';
import type { Hono, Context } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import {
  employmentCreator,
  employmentScopePredicate,
  assertRevision,
  jsonBody,
  readContext,
  requireEmployeeInScope,
  revision,
  uuidParam,
} from './context.js';
import {
  accountSettingBody,
  consumeAccountAfterCommit,
  readAccountSettings,
  saveAccountSettings,
  saveTask,
  taskKey,
  type AccountTask,
} from './exit-account-store.js';
import type { EmploymentContext } from './types.js';

const settingsObject = 'TenantBase.EmploymentSettings';
const receipt = (t: AccountTask) => ({
  businessId: t.businessId,
  employeeId: t.employeeId,
  status: t.status,
  reason: t.reason,
  revision: t.revision,
  attempts: t.attempts,
  recipientUserIds: t.recipientUserIds,
});
async function accountTaskInTenant(tx: Tx, tenantId: string, id: string) {
  const [task] = await tx.select().from(exitAccountTasks).where(taskKey(tenantId, id));
  if (!task) throw new AppError('NOT_FOUND', '账号处理任务不存在');
  return task;
}
async function readScopedAccountTask(tx: Tx, ctx: EmploymentContext, id: string) {
  const task = await accountTaskInTenant(tx, ctx.tenantId, id);
  try {
    await requireEmployeeInScope(tx, ctx, task.employeeId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') throw new AppError('NOT_FOUND', '账号处理任务不存在');
    throw error;
  }
  return task;
}
export function registerExitAccountRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/exit-account/settings', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentSettings');
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => readAccountSettings(tx, ctx.tenantId)));
  });
  router.put('/exit-account/settings', async (c) => {
    const ctx = await readContext(
      c,
      deps,
      'tenant.employment.configuration.write',
      revision(c),
      undefined,
      settingsObject,
    );
    const parsed = accountSettingBody.safeParse(await jsonBody(c));
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '账号停用配置不合法');
    const result = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { op: 'exit-account.settings', revision: ctx.expectedRevision, input: parsed.data },
      guard: {
        before: (tx) =>
          requirePermission(authorizeInTransaction(deps.authorize, tx), {
            ...ctx,
            action: 'tenant.employment.configuration.write',
            resource: settingsObject,
          }),
      },
      execute: async (tx, commandId) => ({
        status: 200,
        body: await saveAccountSettings(tx, { ...ctx, commandId }, parsed.data),
      }),
    });
    return c.json(result.body, result.status);
  });
  router.get('/exit-account/tasks', async (c) => {
    const ctx = await readContext(c, deps, 'object.view');
    const cursor = z.uuid().optional().safeParse(c.req.query('cursor'));
    if (!cursor.success) throw new AppError('VALIDATION_FAILED', '游标不合法');
    const result = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const tasks = await tx
        .select()
        .from(exitAccountTasks)
        .where(
          and(
            eq(exitAccountTasks.tenantId, ctx.tenantId),
            employmentScopePredicate(
              ctx.scope,
              sql`${exitAccountTasks.employeeId}`,
              undefined,
              employmentCreator(ctx.tenantId, sql`${exitAccountTasks.employeeId}`),
            ),
            sql`${ctx.userId}::uuid=ANY(${exitAccountTasks.recipientUserIds})`,
            cursor.data ? sql`${exitAccountTasks.businessId}>${cursor.data}::uuid` : sql`true`,
          ),
        )
        .orderBy(exitAccountTasks.businessId)
        .limit(100);
      const items = tasks.map(receipt);
      return { items, nextCursor: tasks.length === 100 ? tasks.at(-1)!.businessId : null };
    });
    return c.json(result);
  });
  router.get('/exit-account/tasks/:id', async (c) => {
    const ctx = await readContext(c, deps, 'object.view');
    const id = uuidParam(c);
    return c.json(
      await withTenant(deps.db, ctx.tenantId, async (tx) => receipt(await readScopedAccountTask(tx, ctx, id))),
    );
  });
  router.post('/exit-account/tasks/:id/retry', (c) => retry(c, deps));
}
const retryReceipt = (task: AccountTask) => ({
  businessId: task.businessId,
  status: task.status,
  revision: task.revision,
});
async function retry(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const id = uuidParam(c);
  const ctx = { ...tenantOf(c), now: deps.clock(), commandId: '', expectedRevision: revision(c) };
  if (!z.strictObject({}).safeParse(await jsonBody(c)).success)
    throw new AppError('VALIDATION_FAILED', '重试请求体应为空');
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { op: 'exit-account.retry', id, revision: ctx.expectedRevision },
    guard: {
      before: async (tx) => {
        await requirePermission(authorizeInTransaction(deps.authorize, tx), { ...ctx, action: 'admin.user_manage' });
        await accountTaskInTenant(tx, ctx.tenantId, id);
      },
    },
    execute: async (tx, commandId) => {
      const before = await accountTaskInTenant(tx, ctx.tenantId, id);
      assertRevision(ctx.expectedRevision, before.revision);
      if (!['blocked', 'failed', 'pending'].includes(before.status)) return { status: 200, body: retryReceipt(before) };
      const after = await saveTask(tx, { ...ctx, commandId }, before, {
        status: 'pending',
        reason: null,
        commandId,
      });
      if (!after) throw new AppError('REVISION_CONFLICT', '账号处理任务已变化');
      consumeAccountAfterCommit(tx, { ...ctx, commandId }, id);
      return { status: 200, body: retryReceipt(after) };
    },
  });
  return c.json(result.body, result.status);
}
