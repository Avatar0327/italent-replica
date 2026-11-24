import { withTenant } from '@italent/db';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { runSourceSignCommand } from '../esign/source-initiation.js';
import { parseBody } from '../job/context.js';
import { revision, uuidParam } from './context.js';
import { entrySignHistory } from './entry-esign-history.js';
import {
  authorizeEntrySignSource,
  entrySignContext,
  lockEntrySignSource,
  missingEntrySignSource,
} from './entry-esign-source.js';
import { parse } from './entry-routes.js';

const signReceipt = z.object({ sourceId: z.uuid(), taskId: z.uuid() });
const startBody = z.strictObject({ templateIds: z.array(z.uuid()).min(1).max(20) });
const pageInput = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const requestContext = (c: Context<TenantEnv>, deps: TenantRouteDeps, expectedRevision = 0) => ({
  ...tenantOf(c),
  now: deps.clock(),
  commandId: '',
  expectedRevision,
});

export function registerEntrySignRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/pending-entries/:id/esign-context', async (c) => {
    const id = uuidParam(c);
    const ctx = requestContext(c, deps);
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => entrySignContext(tx, deps, ctx, id)));
  });

  router.post('/pending-entries/:id/esign-tasks', async (c) => {
    const id = uuidParam(c);
    const ctx = requestContext(c, deps, revision(c));
    const { templateIds } = await parseBody(c, startBody);
    // F-553 已登记这个命令类型。审计请求上下文用实际路径生成台账 commandType。
    const result = await runSourceSignCommand(deps.db, deps, ctx, {
      scene: 'entry',
      sourceId: id,
      commandId: c.req.header('idempotency-key'),
      templateIds,
      authorizeSource: (tx) => authorizeEntrySignSource(tx, deps, ctx, id),
      lockSource: (tx, commandId) => lockEntrySignSource(tx, deps, { ...ctx, commandId }, id),
    });
    const receipt = signReceipt.safeParse(result.body);
    if (!receipt.success || receipt.data.sourceId !== id) throw missingEntrySignSource();
    return c.json(receipt.data, result.status);
  });

  router.get('/pending-entries/:id/esign-records', async (c) => {
    const id = uuidParam(c);
    const ctx = requestContext(c, deps);
    const page = parse(pageInput, c.req.query());
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => entrySignHistory(tx, deps, ctx, id, page)));
  });
}
