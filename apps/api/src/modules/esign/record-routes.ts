/** F-481 S3b §4.3/10：记录 view；动作/下载各自按钮；我的文件仅 signer own。 */
import { withTenant } from '@italent/db';
import { z } from 'zod';
import type { Context, Hono } from 'hono';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { button, objectContext } from '../permission/module-route-access.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { parseBody, uuidParam } from '../job/context.js';
import { admitted } from '../survey360/export-runtime.js';
import { RECORD_OBJECT, requireFiles } from './record-access.js';
import { listRecords, actOnRecords, trimReceipts, type Receipt } from './records.js';
import { downloadInputs, generateFiles, logDownload } from './files.js';

const BASE = '/api/tenant/esign';
const uuid = z.uuid().transform((id) => id.toLowerCase());
const batchSchema = z.strictObject({
  items: z.array(z.strictObject({ id: uuid, revision: z.number().int().positive() })).min(1),
});
const querySchema = z.object({
  tab: z.enum(['all', 'signing', 'completed']).default('all'),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const idsSchema = z.array(uuid).min(1);
function valid<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_FAILED', '签署记录参数不合法');
  return result.data;
}
function checkIds(ids: readonly string[]) {
  if (ids.length > 50) throw new AppError('VALIDATION_FAILED', '每批最多 50 条', { reason: 'BATCH_LIMIT_EXCEEDED' });
  if (new Set(ids).size !== ids.length) throw new AppError('VALIDATION_FAILED', '签署任务不可重复');
}
const context = (c: Context<TenantEnv>, deps: TenantRouteDeps) => ({
  ...tenantOf(c),
  now: deps.clock(),
  commandId: '',
  expectedRevision: 0,
});

async function batch(c: Context<TenantEnv>, deps: TenantRouteDeps, action: 'remind' | 'revoke') {
  const ctx = context(c, deps);
  const code = action === 'remind' ? 'ESignRecord.Remind' : 'ESignRecord.Revoke';
  await button(deps, ctx, RECORD_OBJECT, code, 'list');
  const input = await parseBody(c, batchSchema);
  checkIds(input.items.map((item) => item.id));
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, input },
    guard: {
      before: async (tx) => {
        await button(
          { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) },
          ctx,
          RECORD_OBJECT,
          code,
          'list',
        );
      },
    },
    execute: async (tx, commandId) => {
      const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, RECORD_OBJECT);
      return { status: 200, body: await actOnRecords(tx, { ...ctx, commandId }, scope, input.items, action) };
    },
  });
  // 初次结果、台账命中与失败回查共享此出口；成功和失败回执都按当前范围复核。
  const body = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    await button({ ...deps, authorize: authorizeInTransaction(deps.authorize, tx) }, ctx, RECORD_OBJECT, code, 'list');
    const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, RECORD_OBJECT);
    return trimReceipts(tx, ctx, scope, result.body as { items: Receipt[] });
  });
  return c.json(body, result.status);
}

async function download(c: Context<TenantEnv>, deps: TenantRouteDeps, own: boolean) {
  const ctx = context(c, deps);
  const inputs = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    if (own) return downloadInputs(tx, ctx, [uuidParam(c)], 'own', undefined);
    await button(
      { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) },
      ctx,
      RECORD_OBJECT,
      'ESignRecord.Download',
      'list',
    );
    const fields = await getModuleViewableFieldsInTransaction(deps, ctx, RECORD_OBJECT, tx);
    requireFiles(fields);
    const ids = valid(idsSchema, c.req.query('ids')?.split(','));
    checkIds(ids);
    const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, RECORD_OBJECT, `${RECORD_OBJECT}.list`);
    return downloadInputs(tx, ctx, ids, scope, fields);
  });
  const response = await admitted(ctx.tenantId, (signal) => generateFiles(ctx, inputs, signal), {
    signal: c.req.raw.signal,
  });
  await withTenant(deps.db, ctx.tenantId, (tx) => logDownload(tx, ctx, inputs.length));
  return response;
}

export function registerESignRecordRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${BASE}/records`, async (c) => {
    const ctx = await objectContext(c, deps, RECORD_OBJECT, 'view');
    const query = valid(querySchema, c.req.query());
    return c.json(
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, RECORD_OBJECT, `${RECORD_OBJECT}.list`);
        const fields = await getModuleViewableFieldsInTransaction(deps, ctx, RECORD_OBJECT, tx);
        return listRecords(tx, ctx, scope, fields, query);
      }),
    );
  });
  router.post(`${BASE}/records/remind`, (c) => batch(c, deps, 'remind'));
  router.post(`${BASE}/records/revoke`, (c) => batch(c, deps, 'revoke'));
  router.get(`${BASE}/records/files`, (c) => download(c, deps, false));
  router.get(`${BASE}/mine/:id/files`, (c) => download(c, deps, true));
}
