/** #9a / #15 / #15a：命令前与 ledgerExit.before 同一授权；出口复用 A2 的当前权限投影。 */
import { sql, withTenant, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { z } from 'zod';
import type { Context, Hono } from 'hono';
import { runCommand } from '../../commands.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { button } from '../permission/module-route-access.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction, scopeSql } from '../permission/module-access.js';
import { pageQuery, parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import { codeOf, successionContext, SUCCESSION_BASE, type SuccessionContext } from './access.js';
import { readMapDisplayScope } from './map-display.js';
import { enqueueCalcRun } from './calc-worker.js';
import {
  authorizeSuccessionResult,
  checkWriteAccess,
  runSuccessionCommand,
  type ResultAdapter,
  type StoredResult,
} from './write-support.js';
import {
  assignHealth,
  readHealthResults,
  projectHealth,
  healthResults,
  healthMissing,
  requireHealthOrg,
} from './health-results.js';
import { rowsOf } from './read-sql.js';
const PATH = `${SUCCESSION_BASE}/health-results`,
  COMPUTE = `${SUCCESSION_BASE}/maps/org/compute-health`;
const resetBody = z.strictObject({
  items: z
    .array(
      z.strictObject({
        orgId: z.uuid().transform((v) => v.toLowerCase()),
        expectedRevision: z.int().min(0),
      }),
    )
    .min(1)
    .max(200)
    .refine((items) => new Set(items.map((i) => i.orgId)).size === items.length),
});
async function queueAccess(c: Context<TenantEnv>, deps: TenantRouteDeps, tx: Tx, reset: boolean) {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const ctx = reset
    ? await checkWriteAccess(c, bound, {
        object: 'healthResult',
        operation: 'update',
        button: { code: 'reset', level: 'list' },
        expectedRevision: 0,
        payload: { levelId: null },
      })
    : await successionContext(c, bound, 'map');
  if (!reset) await button(bound, ctx, codeOf('map'), 'computeHealth', 'list');
  return { ctx, scope: await resolveModuleScopeInTransaction(bound, ctx, tx, codeOf(reset ? 'healthResult' : 'map')) };
}
function queueResults(c: Context<TenantEnv>, reset: boolean): ResultAdapter<{ id: string }> {
  return {
    object: reset ? 'healthResult' : 'map',
    async load(tx, deps, ctx, ids) {
      const { scope } = await queueAccess(c, deps, tx, reset);
      const views = rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT r.id FROM succession_calc_runs r
        WHERE r.tenant_id=${ctx.tenantId}::uuid AND r.id=ANY(${`{${ids.join(',')}}`}::uuid[])
        AND r.requested_by=${ctx.userId}::uuid AND r.kind=${reset ? 'org_health_reset' : 'org_health'}
        AND NOT EXISTS (SELECT 1 FROM succession_calc_run_objects o WHERE o.tenant_id=r.tenant_id AND o.run_id=r.id
          AND NOT (${scopeSql(scope, { org: sql`o.object_id` })}))`),
      );
      if (views.length !== ids.length) throw healthMissing();
      return { views, revisions: new Map(views.map((v) => [v.id, 1])) };
    },
    project: async (_deps, _ctx, views) => [...views],
  };
}
async function enqueueHealth(c: Context<TenantEnv>, deps: TenantRouteDeps, reset: boolean) {
  const body = reset ? await parseBody(c, resetBody) : await parseBody(c, z.strictObject({}));
  if (!reset) requireNew(revision(c));
  const object = reset ? 'healthResult' : 'map';
  const ctx = await successionContext(c, deps, object, reset ? 'update' : 'view');
  const results = queueResults(c, reset);
  const response = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { path: c.req.path, body },
    guard: {
      before: async (tx) => {
        const { scope } = await queueAccess(c, deps, tx, reset);
        if ('items' in body)
          for (const item of body.items)
            await requireHealthOrg(tx, ctx.tenantId, item.orgId, tenantLocalDate(ctx.now, ctx.timezone), scope);
      },
      replayed: async (tx, stored) => {
        await results.load(tx, deps, ctx, (stored.body as StoredResult).ids, { includeDeleted: false });
      },
    },
    execute: async (tx, commandId) => {
      const { scope } = await queueAccess(c, deps, tx, reset),
        asOf = tenantLocalDate(ctx.now, ctx.timezone);
      const objects =
        'items' in body
          ? body.items.map((i) => ({
              objectType: 'org' as const,
              objectId: i.orgId,
              expectedRevision: i.expectedRevision,
            }))
          : (await readMapDisplayScope(tx, { ...ctx, scope, asOf }, 'org', undefined, 'saved', 'health')).map(
              (objectId) => ({ objectType: 'org' as const, objectId }),
            );
      const id = await enqueueCalcRun(
        tx,
        {
          tenantId: ctx.tenantId,
          kind: reset ? 'org_health_reset' : 'org_health',
          trigger: 'manual',
          commandId,
          requestedBy: ctx.userId,
          businessDate: asOf,
          objects,
        },
        ctx.now,
      );
      return { status: 202, body: { kind: 'record', ids: [id], commandId } satisfies StoredResult };
    },
  });
  await authorizeSuccessionResult(deps, ctx, response.body as StoredResult, results);
  return c.json({ runId: (response.body as StoredResult).ids[0] }, 202);
}
export function registerHealthRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(PATH, async (c) => {
    const ctx = await successionContext(c, deps, 'healthResult'),
      page = pageQuery(c);
    const found = await withTenant(deps.db, ctx.tenantId, (tx) => readHealthResults(tx, deps, ctx, page));
    return c.json({
      page: page.page,
      pageSize: page.pageSize,
      total: found.total,
      items: await projectHealth(deps, ctx, found.views),
    });
  });
  router.put(`${PATH}/:orgId`, async (c) => {
    const id = uuidParam(c, 'orgId'),
      expectedRevision = revision(c);
    const body = await parseBody(
      c,
      z.strictObject({
        levelId: z
          .uuid()
          .transform((v) => v.toLowerCase())
          .nullable(),
      }),
    );
    const spec = {
      operation: 'update' as const,
      button: { code: 'assign', level: 'detail' as const },
      expectedRevision,
      input: { id, body },
      payload: body,
      status: 200 as const,
      results: healthResults,
      execute: async (tx: Tx, ctx: SuccessionContext & { scope: Parameters<typeof scopeSql>[0] }) => {
        await assignHealth(tx, ctx, ctx.scope, id, expectedRevision, body.levelId);
        return { kind: 'record' as const, ids: [id] };
      },
    };
    const ctx = await checkWriteAccess(c, deps, { ...spec, object: 'healthResult' });
    const { result } = await runSuccessionCommand(c, deps, ctx, spec);
    const found = await authorizeSuccessionResult(deps, ctx, result, healthResults);
    c.header('ETag', `"${found.revisions.get(id)}"`);
    return c.json(found.items[0], 200);
  });
  router.post(COMPUTE, (c) => enqueueHealth(c, deps, false));
  router.post(`${PATH}/reset`, (c) => enqueueHealth(c, deps, true));
}
