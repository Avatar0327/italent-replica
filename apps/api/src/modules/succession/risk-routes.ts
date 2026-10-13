import { sql, withTenant, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { button } from '../permission/module-route-access.js';
import { pageQuery, parseBody, revision, requireNew, uuidParam } from '../talent/http.js';
import { loadJobObject } from '../job/read-model.js';
import { codeOf, successionContext, SUCCESSION_BASE } from './access.js';
import { preferenceBody } from './map-preferences.js';
import { readMapDisplayScope } from './map-display.js';
import { enqueueCalcRun } from './calc-worker.js';
import { calcObjectVisible } from './calc-read.js';
import { rowsOf } from './read-sql.js';
import { readRiskRows, projectRisk, riskResults, assignRisk } from './risk-store.js';
import {
  authorizeSuccessionResult,
  checkWriteAccess,
  runSuccessionCommand,
  type ResultAdapter,
  type StoredResult,
} from './write-support.js';
const COMPUTE = `${SUCCESSION_BASE}/maps/position/compute-risk`;
async function computeAccess(c: Context<TenantEnv>, deps: TenantRouteDeps, tx: Tx) {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const ctx = await successionContext(c, bound, 'map');
  await button(bound, ctx, codeOf('map'), 'computeRisk', 'list');
  return { ctx, scope: await resolveModuleScopeInTransaction(bound, ctx, tx, codeOf('map')) };
}
const riskRunResults: ResultAdapter<{ id: string }> = {
  object: 'map',
  async load(tx, deps, ctx, ids) {
    const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
    await requirePermission(bound.authorize, { ...ctx, action: 'object.view', resource: codeOf('map'), fields: [] });
    await button(bound, ctx, codeOf('map'), 'computeRisk', 'list');
    const scope = await resolveModuleScopeInTransaction(bound, ctx, tx, codeOf('map'));
    const views = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT r.id FROM succession_calc_runs r
      WHERE r.tenant_id=${ctx.tenantId}::uuid AND r.id=ANY(${`{${ids.join(',')}}`}::uuid[])
      AND r.kind='position_risk' AND r.requested_by=${ctx.userId}::uuid AND NOT EXISTS (
        SELECT 1 FROM succession_calc_run_objects o WHERE o.tenant_id=r.tenant_id AND o.run_id=r.id
        AND NOT (${calcObjectVisible(scope, ctx.tenantId, tenantLocalDate(ctx.now, ctx.timezone))}))`),
    );
    if (views.length !== ids.length) throw new AppError('NOT_FOUND', '风险任务不存在');
    return { views, revisions: new Map(views.map((v) => [v.id, 1])) };
  },
  project: async (_deps, _ctx, views) => [...views],
};
export function registerRiskRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post(COMPUTE, async (c) => {
    const ctx = await successionContext(c, deps, 'map');
    await button(deps, ctx, codeOf('map'), 'computeRisk', 'list');
    const expected = revision(c);
    requireNew(expected);
    const body = await parseBody(c, preferenceBody.partial());
    const response = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { path: c.req.path, expectedRevision: expected, body },
      guard: {
        before: async (tx) => {
          await computeAccess(c, deps, tx);
        },
        replayed: async (tx, result) => {
          await riskRunResults.load(tx, deps, ctx, (result.body as StoredResult).ids, { includeDeleted: false });
        },
      },
      execute: async (tx, commandId) => {
        const { scope } = await computeAccess(c, deps, tx);
        const asOf = tenantLocalDate(ctx.now, ctx.timezone);
        const displayed = await readMapDisplayScope(
          tx,
          { ...ctx, scope, asOf },
          'position',
          body,
          Object.keys(body).length ? 'submitted' : 'saved',
        );
        const objects = [];
        for (const objectId of displayed)
          if ((await loadJobObject(tx, ctx.tenantId, 'positions', objectId, asOf))?.isKey)
            objects.push({ objectId, objectType: 'position' as const });
        const id = await enqueueCalcRun(
          tx,
          {
            tenantId: ctx.tenantId,
            kind: 'position_risk',
            trigger: 'manual',
            requestedBy: ctx.userId,
            commandId,
            businessDate: asOf,
            objects,
          },
          ctx.now,
        );
        return { status: 202, body: { kind: 'record', ids: [id], commandId } satisfies StoredResult };
      },
    });
    await authorizeSuccessionResult(deps, ctx, response.body as StoredResult, riskRunResults);
    return c.json({ runId: (response.body as StoredResult).ids[0] }, 202);
  });
  registerRiskResultRoutes(router, deps);
}
function registerRiskResultRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${SUCCESSION_BASE}/risk-results`, async (c) => {
    const ctx = await successionContext(c, deps, 'riskResult');
    const page = pageQuery(c);
    const result = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
      const current = await successionContext(c, bound, 'riskResult');
      return readRiskRows(tx, bound, current, undefined, page);
    });
    return c.json({
      items: await projectRisk(deps, ctx, result.views),
      total: result.total,
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: result.hasDataPermission,
    });
  });
  router.put(`${SUCCESSION_BASE}/risk-results/:positionId`, async (c) => {
    const positionId = uuidParam(c, 'positionId');
    const payload = await parseBody(
      c,
      z.strictObject({
        levelId: z
          .uuid()
          .transform((s) => s.toLowerCase())
          .nullable(),
      }),
    );
    const spec = {
      operation: 'update' as const,
      button: { code: 'assign', level: 'detail' as const },
      expectedRevision: revision(c),
      payload,
      input: { positionId, ...payload },
      status: 200 as const,
      results: riskResults,
      execute: async (tx: Tx, ctx: Parameters<typeof assignRisk>[1]) => {
        const result = await assignRisk(tx, ctx, positionId, payload.levelId);
        // DEC-450：清除与单职位 run 同事务；命令重放只读台账，不重复登记。
        if (payload.levelId === null)
          await enqueueCalcRun(
            tx,
            {
              tenantId: ctx.tenantId,
              kind: 'position_risk',
              trigger: 'manual',
              requestedBy: ctx.userId,
              commandId: ctx.commandId,
              businessDate: ctx.today,
              objects: [{ objectType: 'position', objectId: positionId }],
            },
            ctx.now,
          );
        return result;
      },
    };
    const ctx = await checkWriteAccess(c, deps, { ...spec, object: 'riskResult' });
    const { result } = await runSuccessionCommand(c, deps, ctx, spec);
    const output = await authorizeSuccessionResult(deps, ctx, result, riskResults);
    c.header('ETag', `"${output.revisions.get(positionId)}"`);
    return c.json(output.items[0]);
  });
}
