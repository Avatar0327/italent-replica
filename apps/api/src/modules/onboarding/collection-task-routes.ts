import { createHash } from 'node:crypto';
import { withTenant, type Tx } from '@italent/db';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import { policedSub } from '../../route-policy/index.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import type { EmploymentContext } from '../employment/types.js';
import { pageQuery, parseBody, revision, uuidParam } from '../job/context.js';
import { requireCollectionTarget, requireCollectionWrite, type WriteAction } from './collection-access.js';
import { COLLECTION_TASK_POLICIES } from './collection-task-policy.js';
import { projectCollectionTask } from './collection-task-view.js';
import {
  changeCollectionTask,
  collectionReceipt,
  loadCollectionTask,
  startCollection,
  type CollectionAction,
} from './collection-tasks.js';

const uuid = z.uuid().transform((id) => id.toLowerCase());
const ver = z.int().min(0);
const entryRef = z.strictObject({ businessId: uuid, businessRevision: ver, caseRevision: ver });
const commentInput = entryRef.extend({
  text: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine((text) => !text.includes('\0')),
});
const batchInput = z
  .strictObject({
    targets: z
      .array(entryRef.extend({ id: uuid, revision: ver }))
      .min(1)
      .max(100),
  })
  .refine(
    ({ targets }) =>
      new Set(targets.map(({ id }) => id)).size === targets.length &&
      targets.every(({ id, businessId }) => id === businessId),
    '批量必须提交不同且相符的待入职记录',
  );

type Ctx = Context<TenantEnv>;
type EntryInput = z.infer<typeof entryRef> & { text?: string };
type Receipt = ReturnType<typeof collectionReceipt>;
type Stored = { receipt: Receipt } | { failure: string };

function context(c: Ctx, deps: TenantRouteDeps, expectedRevision = 0): EmploymentContext {
  return { ...tenantOf(c), now: deps.clock(), commandId: '', expectedRevision };
}

async function readCollection(c: Ctx, deps: TenantRouteDeps) {
  const id = uuidParam(c, 'businessId');
  const ctx = context(c, deps);
  const page = pageQuery(c);
  const dto = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    const { stage, businessRevision, pending } = await requireCollectionTarget(tx, deps, ctx, id, 'read');
    const task = await loadCollectionTask(tx, ctx.tenantId, stage.id);
    return {
      businessId: id,
      businessRevision,
      caseRevision: stage.revision,
      ...(await projectCollectionTask(tx, deps, ctx, stage, task, page, pending)),
    };
  });
  c.header('Cache-Control', 'private, no-store');
  return c.json(dto);
}

async function executeTask(
  tx: Tx,
  ctx: EmploymentContext,
  target: Awaited<ReturnType<typeof requireCollectionTarget>>,
  input: EntryInput,
  action: CollectionAction,
) {
  const ref = { ...input, employeeId: target.stage.employeeId, caseId: target.stage.id };
  const scoped = { ...ctx, scope: target.scope };
  if (action !== 'start') return changeCollectionTask(tx, scoped, ref, action, input.text ?? '');
  const result = await startCollection(tx, scoped, ref, 'manual');
  if (result.status === 'skipped') throw new AppError('CONFLICT', '当前待入职无法发起采集', { reason: result.reason });
  return collectionReceipt(result.task);
}

async function taskCommand(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  id: string,
  input: EntryInput,
  action: CollectionAction,
  key: string | undefined,
  batch = false,
) {
  let target: Awaited<ReturnType<typeof requireCollectionTarget>>;
  const result = await runCommand(deps.db, ctx, {
    id: key,
    fingerprint: { action, id, input, revision: ctx.expectedRevision, batch },
    guard: {
      before: async (tx) => {
        await requireCollectionWrite(tx, deps, ctx, batch ? 'batch' : action);
        target = await requireCollectionTarget(tx, deps, ctx, id, 'write');
      },
    },
    execute: async (tx, commandId) => {
      const execute = (nested: Tx) => executeTask(nested, { ...ctx, commandId }, target, input, action);
      try {
        const receipt = batch ? await tx.transaction(execute) : await execute(tx);
        // F-120 仅有固定摘要，任务目标和内容必须经本入口的当前权限复核。
        return { status: action === 'remind' ? 200 : 201, body: { receipt } };
      } catch (error) {
        if (!batch || !(error instanceof AppError) || error.status !== 409) throw error;
        const reason = (error.details as { reason?: string } | undefined)?.reason;
        return { status: 409, body: { failure: reason ?? error.code } };
      }
    },
  });
  return result.body as Stored;
}

async function writeCollection(c: Ctx, deps: TenantRouteDeps, action: CollectionAction) {
  const id = uuidParam(c, 'businessId');
  const input = await parseBody(c, action === 'comments' ? commentInput : entryRef);
  if (input.businessId !== id) throw new AppError('VALIDATION_FAILED', '待入职标识必须与路由一致');
  const ctx = context(c, deps, revision(c));
  const result = await taskCommand(deps, ctx, id, input, action, c.req.header('idempotency-key'));
  if (!('receipt' in result)) throw new Error('单笔采集命令缺少回执');
  c.header('ETag', `"${result.receipt.revision}"`);
  return c.json(result.receipt, action === 'remind' ? 200 : 201);
}

function childKey(parent: string, id: string) {
  return (
    'be16-collection:' +
    createHash('sha256')
      .update(JSON.stringify([parent, id]))
      .digest('hex')
  );
}

async function startBatch(c: Ctx, deps: TenantRouteDeps) {
  const { targets } = await parseBody(c, batchInput);
  const ctx = context(c, deps, revision(c));
  if (ctx.expectedRevision !== 0) throw new AppError('REVISION_CONFLICT', '批量父命令版本必须为 0');
  const id = c.req.header('idempotency-key');
  await runCommand(deps.db, ctx, {
    id,
    fingerprint: { action: 'collection.start-batch', targets },
    guard: { before: (tx) => requireCollectionWrite(tx, deps, ctx, 'batch') },
    execute: async () => ({ status: 202, body: { targets: targets.map(({ id }) => id) } }),
  });
  const items = [];
  for (const { id: businessId, revision: expectedRevision, ...input } of targets) {
    try {
      const item = await taskCommand(
        deps,
        { ...ctx, expectedRevision },
        businessId,
        input,
        'start',
        childKey(id!, businessId),
        true,
      );
      items.push(
        'receipt' in item
          ? { id: businessId, revision: item.receipt.revision, status: item.receipt.status }
          : { id: businessId, status: 'failed', code: item.failure },
      );
    } catch (error) {
      if (!(error instanceof AppError) || ![403, 404].includes(error.status)) throw error;
    }
  }
  return c.json({ items });
}

export const registerCollectionTasks: TenantRouteModule = (router, deps) => {
  const module = policedSub(router, COLLECTION_TASK_POLICIES, () => new Hono<TenantEnv>());
  module.get('/entries/:businessId/collection', (c) => readCollection(c, deps));
  module.post('/entries/:businessId/collection/start', (c) => writeCollection(c, deps, 'start'));
  module.post('/entries/:businessId/collection/remind', (c) => writeCollection(c, deps, 'remind'));
  module.post('/entries/:businessId/collection/comments', (c) => writeCollection(c, deps, 'comments'));
  module.post('/collection/start-batch', (c) => startBatch(c, deps));
  router.route('/api/tenant/onboarding', module);
};
