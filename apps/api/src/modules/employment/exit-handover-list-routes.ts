/** F-317：列表行和批量首次发起，各路由固定原站按钮编码，不接受客户端选择授权上下文。 */
import { withTenant } from '@italent/db';
import { HANDOVER_BATCH_SUBMIT_BUTTON, HANDOVER_ROW_SUBMIT_BUTTON } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { normalizedUuid } from './fields.js';
import { commandContext, jsonBody, readContext, requireEmploymentWrite, revision, uuidParam } from './context.js';
import { EXIT_BATCH_LIMIT } from './exit-batch.js';
import { submitHandoverBatch } from './exit-handover-batch.js';
import { handoverSubmitGuard, requireHandoverSubmit, submitExitHandover } from './exit-handover-launch.js';

const batchBody = z.strictObject({
  items: z
    .array(z.strictObject({ exitRequestId: normalizedUuid, revision: z.int().min(1) }))
    .min(1)
    .max(EXIT_BATCH_LIMIT)
    .refine((items) => new Set(items.map((item) => item.exitRequestId)).size === items.length, '离职单不能重复'),
});

export function registerHandoverListRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/exits/:id/handover/submit-from-list', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    await withTenant(deps.db, ctx.tenantId, (tx) =>
      requireHandoverSubmit(tx, ctx, id, HANDOVER_ROW_SUBMIT_BUTTON.code),
    );
    if (!z.strictObject({}).safeParse(await jsonBody(c)).success)
      throw new AppError('VALIDATION_FAILED', '发起交接只接受空请求体');
    const result = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input: {} },
      guard: handoverSubmitGuard(deps, ctx, id, HANDOVER_ROW_SUBMIT_BUTTON.code),
      execute: async (tx, commandId) => ({
        status: 200,
        body: await submitExitHandover(tx, { ...(await commandContext(tx, deps, ctx)), commandId }, id),
      }),
    });
    c.header('ETag', `"${(result.body as { revision: number }).revision}"`);
    return c.json(result.body, result.status);
  });
  router.post('/exits/handover/batch-submit', async (c) => {
    const ctx = await readContext(c, deps, 'object.update');
    await requireEmploymentWrite(ctx, 'update', {}, HANDOVER_BATCH_SUBMIT_BUTTON.code, undefined, {
      commandOnly: true,
    });
    const input = batchBody.safeParse(await jsonBody(c));
    if (!input.success) throw new AppError('VALIDATION_FAILED', '批量发起交接参数不合法', input.error.issues);
    const result = await submitHandoverBatch(
      deps,
      ctx,
      c.req.header('idempotency-key'),
      { method: c.req.method, path: c.req.path, input: input.data },
      input.data.items,
    );
    return c.json(result.body, result.status);
  });
}
