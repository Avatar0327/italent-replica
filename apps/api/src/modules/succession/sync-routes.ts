/** #16/#17：命令只登记驱动请求；提交后调用同一消费服务，页事务保持独立。 */
import { randomUUID } from 'node:crypto';
import { eq, and, withTenant, successionSyncBatches as batches, type Tx } from '@italent/db';
import type { Hono, Context } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { pageQuery, parseBody, revision, uuidParam } from '../talent/http.js';
import { successionContext, SUCCESSION_BASE, type SuccessionContext } from './access.js';
import { authorizeSuccessionResult, checkWriteAccess, type StoredResult } from './write-support.js';
import { readSync, readSyncRows, projectSync, syncResults, syncAdmin } from './sync-read.js';
import { consumeRun, ensureBatch, mutex, save, type SyncDeps } from './sync-consume.js';
import { abortSync, batchWhere, notRetryable, requesterScope, terminalBatch, type SyncBatch } from './sync-control.js';
import { authorizeRequesterTargets } from './sync-access.js';
import { collectTargets, readPlan } from './sync-plan.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { getSuccessionSync } from './ports.js';
const PATH = `${SUCCESSION_BASE}/sync-batches`;
const runBody = z.strictObject({ runId: z.uuid().transform((value) => value.toLowerCase()) });
async function checkTargets(tx: Tx, deps: SyncDeps, ctx: SuccessionContext, runId: string, batch?: SyncBatch) {
  if (batch?.hasPlan)
    return requesterScope(
      tx,
      deps,
      { tenantId: ctx.tenantId, runId, leaseOwner: '', requesterUserId: ctx.userId },
      ctx.timezone,
      batch,
    );
  const header = await deps.port.loadRun(tx, { tenantId: ctx.tenantId, runId });
  if (!header) throw new AppError('NOT_FOUND', '同步来源不存在');
  const plan = await readPlan(tx, ctx.tenantId, runId, deps.port);
  const strategy = (await readEffectiveSetting(tx, ctx.tenantId, 'succession.sync_strategy')).value as NonNullable<
    SyncBatch['strategy']
  >;
  const targets = await collectTargets(tx, ctx.tenantId, header, plan, strategy);
  await authorizeRequesterTargets(deps, tx, ctx, targets);
}
function requireSyncPort(deps: TenantRouteDeps): SyncDeps {
  const provider = getSuccessionSync(deps);
  if (!provider) throw new AppError('SERVICE_UNAVAILABLE', '同步端口尚未装配', { reason: 'SOURCE_UNAVAILABLE' });
  return provider;
}
async function writeSync(c: Context<TenantEnv>, deps: TenantRouteDeps, action: 'sync' | 'retry' | 'abort') {
  const runId = action === 'sync' ? (await parseBody(c, runBody)).runId : undefined;
  if (action !== 'sync') await parseBody(c, z.strictObject({}));
  const id = action === 'sync' ? undefined : uuidParam(c),
    expectedRevision = action === 'sync' ? 0 : revision(c);
  const spec = {
    object: 'syncBatch',
    operation: action === 'sync' ? 'create' : 'update',
    button: { code: action, level: action === 'sync' ? 'list' : 'detail' },
    expectedRevision,
  } as const;
  const ctx = await checkWriteAccess(c, deps, spec);
  let batch: SyncBatch | undefined;
  const currentPort = () => requireSyncPort(deps);
  const response = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { path: c.req.path, runId, expectedRevision },
    guard: {
      before: async (tx) => {
        await mutex(tx, ctx.tenantId);
        await checkWriteAccess(c, { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) }, spec);
        [batch] = await tx
          .select()
          .from(batches)
          .where(
            id
              ? batchWhere(ctx.tenantId, id)
              : and(eq(batches.tenantId, ctx.tenantId), eq(batches.sourceRunId, runId!)),
          );
        if (id) await readSync(tx, deps, ctx, { limit: 1, offset: 0 }, [id]);
        if (action === 'abort') {
          if (!(await syncAdmin(tx, ctx))) throw new AppError('FORBIDDEN', '仅继任管理员可终止');
        } else if (!batch || !terminalBatch(batch))
          await checkTargets(tx, currentPort(), ctx, runId ?? batch!.sourceRunId, batch);
      },
      replayed: async (tx, result) => {
        await syncResults.load(tx, deps, ctx, (result.body as StoredResult).ids, { includeDeleted: false });
      },
    },
    execute: async (tx, commandId) => {
      if (batch && action !== 'abort') {
        [batch] = await tx.select().from(batches).where(batchWhere(ctx.tenantId, batch.id)).for('update');
      }
      if (batch && terminalBatch(batch)) throw notRetryable();
      if (batch && id && batch.revision !== expectedRevision)
        throw new AppError('REVISION_CONFLICT', '同步批次已变化', { reason: 'REVISION_MISMATCH' });
      const sync = currentPort();
      if (action === 'abort') batch = await abortSync(tx, sync, batch!, commandId, expectedRevision, ctx.userId);
      else {
        if (!batch) {
          const header = await sync.port.loadRun(tx, { tenantId: ctx.tenantId, runId: runId! });
          if (!header) throw new AppError('NOT_FOUND', '同步来源不存在');
          batch = await ensureBatch(tx, { tenantId: ctx.tenantId, runId: runId!, leaseOwner: commandId }, header);
        }
        batch = await save(
          tx,
          batch,
          { nextRetryAt: ctx.now, autoRetryCount: 0 },
          ctx.now,
          commandId,
          action,
          ctx.userId,
        );
      }
      return {
        status: action === 'abort' ? 200 : 202,
        body: { kind: 'record', ids: [batch.id], commandId } satisfies StoredResult,
      };
    },
  });
  const stored = response.body as StoredResult;
  if (action !== 'abort') await driveSync(deps, ctx, stored.ids[0]!);
  const result = await authorizeSuccessionResult(deps, ctx, stored, syncResults);
  c.header('ETag', `"${result.revisions.get(stored.ids[0]!)}"`);
  return c.json(result.items[0], response.status);
}
async function driveSync(deps: TenantRouteDeps, ctx: SuccessionContext, id: string) {
  // 已提交的驱动请求可由恢复扫描接续；终态重放只投影，不再次执行。
  const [fresh] = await withTenant(deps.db, ctx.tenantId, (tx) =>
    tx.select().from(batches).where(batchWhere(ctx.tenantId, id)),
  );
  if (fresh && !terminalBatch(fresh))
    await consumeRun(requireSyncPort(deps), {
      tenantId: ctx.tenantId,
      runId: fresh.sourceRunId,
      leaseOwner: randomUUID(),
      requesterUserId: ctx.userId,
    });
}
export function registerSyncRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(PATH, async (c) => {
    const ctx = await successionContext(c, deps, 'syncBatch'),
      page = pageQuery(c);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) => readSync(tx, deps, ctx, page));
    return c.json({
      page: page.page,
      pageSize: page.pageSize,
      total: result.total,
      items: await projectSync(deps, ctx, result.views),
    });
  });
  router.get(`${PATH}/:id`, async (c) => {
    const ctx = await successionContext(c, deps, 'syncBatch'),
      id = uuidParam(c);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) =>
      readSync(tx, deps, ctx, { limit: 1, offset: 0 }, [id]),
    );
    c.header('ETag', `"${result.views[0]!.revision}"`);
    return c.json((await projectSync(deps, ctx, result.views))[0]);
  });
  const rows = async (c: Context<TenantEnv>, kind: 'items' | 'targets') => {
    const ctx = await successionContext(c, deps, 'syncBatch'),
      id = uuidParam(c),
      page = pageQuery(c);
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => readSyncRows(tx, deps, ctx, id, kind, page)));
  };
  router.get(`${PATH}/:id/items`, (c) => rows(c, 'items'));
  router.get(`${PATH}/:id/targets`, (c) => rows(c, 'targets'));
  router.post(`${SUCCESSION_BASE}/sync`, (c) => writeSync(c, deps, 'sync'));
  router.post(`${PATH}/:id/retry`, (c) => writeSync(c, deps, 'retry'));
  router.post(`${PATH}/:id/abort`, (c) => writeSync(c, deps, 'abort'));
}
