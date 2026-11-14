/** F-326 S2 管理接口，写入口的首次执行、重放和失败回查均经 CommandGuard.before。 */
import { withTenant, type Tx } from '@italent/db';
import type { z } from 'zod';
import type { Context, Hono } from 'hono';
import { runCommand } from '../../commands.js';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { parseBody, revision, uuidParam } from '../job/context.js';
import { canonicalId, type ApprovalContext } from './context.js';
import { requireProcessButton } from './access.js';
import {
  createVariableSchema,
  updateVariableSchema,
  variableCommandSchema,
  variableQuerySchema,
} from './variable-input.js';
import { sourceUsagePage } from './source-usages.js';
import {
  createVariable,
  listVariables,
  loadVariable,
  setVariableStatus,
  updateVariable,
  variableDetail,
} from './variables.js';

async function context(c: Context<TenantEnv>, deps: TenantRouteDeps): Promise<ApprovalContext> {
  const tenant = tenantOf(c);
  const ctx = {
    ...tenant,
    tenantId: canonicalId(tenant.tenantId),
    userId: canonicalId(tenant.userId),
    now: deps.clock(),
    commandId: '',
    expectedRevision: 0,
  };
  await requireProcessButton(deps, ctx, 'update');
  return ctx;
}

async function variableWrite<T>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  schema: z.ZodType<T>,
  execute: (tx: Tx, ctx: ApprovalContext, input: T) => Promise<unknown>,
  status: 200 | 201 = 200,
) {
  const ctx = { ...(await context(c, deps)), expectedRevision: revision(c) };
  const input = await parseBody(c, schema);
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input },
    guard: {
      before: (tx) =>
        requirePermission(authorizeInTransaction(deps.authorize, tx), {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          timezone: ctx.timezone,
          action: 'admin.process_matrix',
        }),
    },
    execute: async (tx, commandId) => ({ status, body: await execute(tx, { ...ctx, commandId }, input) }),
  });
  const value = result.body as { revision: number };
  c.header('ETag', `"${value.revision}"`);
  return c.json(result.body, result.status);
}

export function registerVariableRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/variables', async (c) => {
    const ctx = await context(c, deps);
    const query = variableQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new AppError('VALIDATION_FAILED', '变量查询参数不合法');
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => listVariables(tx, ctx.tenantId, query.data)));
  });
  router.get('/variables/:id', async (c) => {
    const ctx = await context(c, deps);
    const id = canonicalId(uuidParam(c));
    const value = await withTenant(deps.db, ctx.tenantId, (tx) => variableDetail(tx, ctx.tenantId, id));
    c.header('ETag', `"${value.revision}"`);
    return c.json(value);
  });
  router.post('/variables', (c) => variableWrite(c, deps, createVariableSchema, createVariable, 201));
  router.patch('/variables/:id', (c) =>
    variableWrite(c, deps, updateVariableSchema, (tx, ctx, input) =>
      updateVariable(tx, ctx, canonicalId(uuidParam(c)), input),
    ),
  );
  router.post('/variables/:id/enable', (c) =>
    variableWrite(c, deps, variableCommandSchema, (tx, ctx, input) =>
      setVariableStatus(tx, ctx, canonicalId(uuidParam(c)), 'enable', input.acknowledgedReferenceCount),
    ),
  );
  router.post('/variables/:id/disable', (c) =>
    variableWrite(c, deps, variableCommandSchema, (tx, ctx, input) =>
      setVariableStatus(tx, ctx, canonicalId(uuidParam(c)), 'disable', input.acknowledgedReferenceCount),
    ),
  );
  router.get('/variables/:id/references', async (c) => {
    const ctx = await context(c, deps);
    const id = canonicalId(uuidParam(c));
    return c.json(
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        await loadVariable(tx, ctx.tenantId, id);
        return sourceUsagePage(tx, ctx.tenantId, { kind: 'variable', id });
      }),
    );
  });
}
