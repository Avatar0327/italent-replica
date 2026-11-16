/** F-481 S3a：补发的功能权 + 逐条写范围，以及只按签署人授权的本人入口。 */
import { withTenant } from '@italent/db';
import { z } from 'zod';
import type { Hono } from 'hono';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { parseBody, uuidParam } from '../job/context.js';
import { button, objectContext } from '../permission/module-route-access.js';
import { listMine, mineDetail, ownSignTask, signMine } from './mine.js';
import { authorizeReissue, recheckReissueReceipt, reissueTransfers, REISSUE_BUTTON } from './reissue.js';
import { templateOptions } from './service.js';

const BASE = '/api/tenant/esign';
const uuid = z.uuid().transform((id) => id.toLowerCase());
const uniqueIds = (ids: string[]) => new Set(ids).size === ids.length;
const reissueSchema = z.strictObject({
  items: z
    .array(z.strictObject({ businessId: uuid }))
    .min(1)
    .max(50)
    .refine((items) => uniqueIds(items.map((i) => i.businessId))),
  templateIds: z.array(uuid).min(1).max(20).refine(uniqueIds),
});
const signSchema = z.strictObject({ revision: z.int().min(0).max(2147483647) });
const listSchema = z.object({
  tab: z.enum(['pending', 'done']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});

export function registerESignTaskRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${BASE}/template-options/reissue`, async (c) => {
    const ctx = await objectContext(c, deps, EMPLOYMENT_OBJECT, 'update');
    await button(deps, ctx, EMPLOYMENT_OBJECT, REISSUE_BUTTON, 'list');
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => templateOptions(tx, ctx.tenantId)));
  });
  router.post(`${BASE}/transfer-tasks`, async (c) => {
    const ctx = await objectContext(c, deps, EMPLOYMENT_OBJECT, 'update');
    await button(deps, ctx, EMPLOYMENT_OBJECT, REISSUE_BUTTON, 'list');
    const raw: unknown = await c.req.json().catch(() => undefined);
    if (raw && typeof raw === 'object' && 'items' in raw && Array.isArray(raw.items) && raw.items.length > 50)
      throw new AppError('VALIDATION_FAILED', '一次最多补发 50 条', { reason: 'BATCH_LIMIT_EXCEEDED' });
    const parsed = reissueSchema.safeParse(raw);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '补发参数不合法');
    const input = parsed.data;
    const result = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { method: c.req.method, path: c.req.path, input },
      guard: {
        before: async (tx) => {
          await authorizeReissue(tx, deps, ctx);
        },
        replayed: async (tx, result) => recheckReissueReceipt(tx, await authorizeReissue(tx, deps, ctx), result.body),
      },
      execute: async (tx, commandId) => ({
        status: 200,
        body: await reissueTransfers(tx, { ...(await authorizeReissue(tx, deps, ctx)), commandId }, input),
      }),
    });
    return c.json(result.body, result.status);
  });
  router.get(`${BASE}/mine`, async (c) => {
    const ctx = { ...tenantOf(c), now: deps.clock(), commandId: '', expectedRevision: 0 };
    const parsed = listSchema.safeParse(c.req.query());
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '签署查询参数不合法');
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => listMine(tx, ctx, parsed.data)));
  });
  router.get(`${BASE}/mine/:id`, async (c) => {
    const ctx = { ...tenantOf(c), now: deps.clock(), commandId: '', expectedRevision: 0 };
    const id = uuidParam(c);
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => mineDetail(tx, ctx, id)));
  });
  router.post(`${BASE}/mine/:id/sign`, async (c) => {
    const id = uuidParam(c);
    const input = await parseBody(c, signSchema);
    const ctx = { ...tenantOf(c), now: deps.clock(), commandId: '', expectedRevision: input.revision };
    const result = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { method: c.req.method, path: c.req.path, input },
      guard: {
        before: async (tx) => {
          await ownSignTask(tx, ctx, id);
        },
      },
      execute: (tx, commandId) => signMine(tx, { ...ctx, commandId }, id, deps.clock),
    });
    return c.json(result.body, result.status);
  });
}
