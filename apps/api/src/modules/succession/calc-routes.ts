/** #10：写入口经 ledgerExit.before 锁内授权，所有返回经 A2 authorizeSuccessionResult。 */
import { sql, withTenant } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { pageQuery, parseBody, revision, uuidParam } from '../talent/http.js';
import { successionContext, SUCCESSION_BASE } from './access.js';
import { calcResults, projectCalc, readCalcRuns, readCalcFailures, requireCalcRetryScope } from './calc-read.js';
import { changeCalcRun } from './calc-worker.js';
import { authorizeSuccessionResult, checkWriteAccess, type StoredResult } from './write-support.js';

const PATH = `${SUCCESSION_BASE}/calc-runs`;
export function registerCalcRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(PATH, async (c) => {
    const ctx = await successionContext(c, deps, 'calcRun');
    const page = pageQuery(c);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) => readCalcRuns(tx, deps, ctx, page));
    return c.json({
      page: page.page,
      pageSize: page.pageSize,
      total: result.total,
      items: await projectCalc(deps, ctx, result.views),
    });
  });
  router.get(`${PATH}/:id`, async (c) => {
    const ctx = await successionContext(c, deps, 'calcRun');
    const id = uuidParam(c);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) =>
      readCalcRuns(tx, deps, ctx, { limit: 1, offset: 0 }, [id]),
    );
    c.header('ETag', `"${result.views[0]!.revision}"`);
    return c.json((await projectCalc(deps, ctx, result.views))[0]);
  });
  router.get(`${PATH}/:id/failures`, async (c) => {
    const ctx = await successionContext(c, deps, 'calcRun');
    const id = uuidParam(c),
      page = pageQuery(c);
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => readCalcFailures(tx, deps, ctx, id, page)));
  });
  router.post(`${PATH}/:id/retry`, async (c) => {
    const id = uuidParam(c),
      expectedRevision = revision(c);
    await parseBody(c, z.strictObject({}));
    const spec = {
      object: 'calcRun',
      operation: 'update',
      button: { code: 'retry', level: 'detail' },
      expectedRevision,
    } as const;
    const ctx = await checkWriteAccess(c, deps, spec);
    const response = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { path: c.req.path, expectedRevision },
      guard: {
        before: async (tx) => {
          await checkWriteAccess(c, { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) }, spec);
          await tx.execute(sql`SELECT id FROM succession_calc_runs
            WHERE tenant_id=${ctx.tenantId}::uuid AND id=${id}::uuid FOR UPDATE`);
          await requireCalcRetryScope(tx, deps, ctx, id);
        },
      },
      execute: async (tx, commandId) => {
        await changeCalcRun(tx, ctx.tenantId, id, expectedRevision, 'retry', commandId, ctx.now);
        return { status: 200, body: { kind: 'record', ids: [id], commandId } satisfies StoredResult };
      },
    });
    const result = await authorizeSuccessionResult(deps, ctx, response.body as StoredResult, calcResults);
    c.header('ETag', `"${result.revisions.get(id)}"`);
    return c.json(result.items[0], response.status);
  });
}
