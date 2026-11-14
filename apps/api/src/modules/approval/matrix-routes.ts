import { withTenant, type Tx } from '@italent/db';
import type { Hono, Context } from 'hono';
import type { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { runCommand } from '../../commands.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { parseBody, uuidParam } from '../job/context.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { approvalError, canonicalId, type ApprovalContext } from './context.js';
import {
  matrixCreateSchema,
  matrixUpdateSchema,
  matrixStatusSchema,
  matrixStructureSchema,
  matrixListSchema,
} from './matrix-input.js';
import {
  createMatrix,
  updateMatrix,
  changeMatrixStatus,
  saveMatrixStructure,
  matrixDetail,
  listMatrices,
  assertMatrixExists,
} from './matrices.js';
import { sourceUsagePage } from './source-usages.js';

type C = Context<TenantEnv>;
function context(c: C, deps: TenantRouteDeps): ApprovalContext {
  const tenant = tenantOf(c);
  return {
    ...tenant,
    tenantId: canonicalId(tenant.tenantId),
    userId: canonicalId(tenant.userId),
    now: deps.clock(),
    commandId: '',
    expectedRevision: 0,
  };
}
async function requireMatrixAdmin(deps: TenantRouteDeps, ctx: ApprovalContext, tx: Tx) {
  await requirePermission(authorizeInTransaction(deps.authorize, tx), {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    action: 'admin.process_matrix',
  });
}

/** 首次执行和所有重放都由 ledgerExit 调用同一个事务内 before。 */
async function matrixCommand<T>(
  c: C,
  deps: TenantRouteDeps,
  schema: z.ZodType<T>,
  execute: (tx: Tx, ctx: ApprovalContext, input: T) => Promise<unknown>,
  status: 200 | 201 = 200,
) {
  const ctx = context(c, deps);
  const input = await parseBody(c, schema);
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path.toLowerCase(), input },
    guard: { before: (tx) => requireMatrixAdmin(deps, ctx, tx) },
    execute: async (tx, commandId) => ({
      status,
      body: await execute(
        tx,
        {
          ...ctx,
          commandId,
          expectedRevision: (input as { revision?: number }).revision ?? 0,
        },
        input,
      ),
    }),
  });
  return c.json(result.body as object, result.status);
}

export function registerMatrixRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/matrices', async (c) => {
    const ctx = context(c, deps);
    const query = matrixListSchema.safeParse(c.req.query());
    if (!query.success) throw approvalError('VALIDATION_FAILED', 'MATRIX_QUERY_INVALID', '矩阵查询参数不合法');
    return c.json(
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        await requireMatrixAdmin(deps, ctx, tx);
        return listMatrices(tx, ctx.tenantId, query.data);
      }),
    );
  });
  router.get('/matrices/:id', async (c) => {
    const ctx = context(c, deps);
    const id = canonicalId(uuidParam(c));
    return c.json(
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        await requireMatrixAdmin(deps, ctx, tx);
        return matrixDetail(tx, ctx, id);
      }),
    );
  });
  router.post('/matrices', (c) => matrixCommand(c, deps, matrixCreateSchema, createMatrix, 201));
  router.patch('/matrices/:id', (c) => {
    const id = canonicalId(uuidParam(c));
    return matrixCommand(c, deps, matrixUpdateSchema, (tx, ctx, input) => updateMatrix(tx, ctx, id, input));
  });
  router.put('/matrices/:id/structure', (c) => {
    const id = canonicalId(uuidParam(c));
    return matrixCommand(c, deps, matrixStructureSchema, (tx, ctx, input) => saveMatrixStructure(tx, ctx, id, input));
  });
  router.post('/matrices/:id/enable', (c) => {
    const id = canonicalId(uuidParam(c));
    return matrixCommand(c, deps, matrixStatusSchema, (tx, ctx) => changeMatrixStatus(tx, ctx, id, 'enable'));
  });
  router.post('/matrices/:id/disable', (c) => {
    const id = canonicalId(uuidParam(c));
    return matrixCommand(c, deps, matrixStatusSchema, (tx, ctx, input) =>
      changeMatrixStatus(tx, ctx, id, 'disable', input.acknowledgedReferenceCount),
    );
  });
  router.get('/matrices/:id/references', async (c) => {
    const ctx = context(c, deps);
    const id = canonicalId(uuidParam(c));
    return c.json(
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        await requireMatrixAdmin(deps, ctx, tx);
        await assertMatrixExists(tx, ctx.tenantId, id);
        return sourceUsagePage(tx, ctx.tenantId, { kind: 'matrix', id });
      }),
    );
  });
}
