/** #8 / #9：Map.view + 个人白名单；写命令所有出口共用 A2 的结果复核。 */
import { sql, withTenant, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { runCommand } from '../../commands.js';
import { recordAudit } from '../../audit/record.js';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction, scopeSql } from '../permission/module-access.js';
import { button } from '../permission/module-route-access.js';
import { parseBody, revision, requireNew } from '../talent/http.js';
import { codeOf, successionContext, SUCCESSION_BASE, type SuccessionContext } from './access.js';
import { readMapDisplayScope, resolveMapDisplayConditions } from './map-display.js';
import {
  mapKind,
  preferenceBody,
  mapDisplayBody,
  preferenceResults,
  readPreferences,
  type MapKind,
  type MapPreferences,
} from './map-preferences.js';
import { enqueueCalcRun } from './calc-worker.js';
import { rowsOf } from './read-sql.js';
import { authorizeSuccessionResult, type ResultAdapter, type StoredResult } from './write-support.js';
const PREFS = `${SUCCESSION_BASE}/maps/:kind/preferences`;
const STATS = `${SUCCESSION_BASE}/maps/org/compute-stats`;
async function mapAccess(c: Context<TenantEnv>, deps: TenantRouteDeps, tx: Tx, compute: boolean) {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const ctx = await successionContext(c, bound, 'map');
  if (compute) await button(bound, ctx, codeOf('map'), 'computeStats', 'list');
  return { ctx, scope: await resolveModuleScopeInTransaction(bound, ctx, tx, codeOf('map')) };
}
const statsResults: ResultAdapter<{ id: string }> = {
  object: 'map',
  async load(tx, deps, ctx, ids) {
    const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
    await requirePermission(bound.authorize, { ...ctx, action: 'object.view', resource: codeOf('map'), fields: [] });
    await button(bound, ctx, codeOf('map'), 'computeStats', 'list');
    const scope = await resolveModuleScopeInTransaction(bound, ctx, tx, codeOf('map'));
    const views = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT r.id FROM succession_calc_runs r
      WHERE r.tenant_id=${ctx.tenantId}::uuid AND r.id=ANY(${`{${ids.join(',')}}`}::uuid[])
      AND r.requested_by=${ctx.userId}::uuid AND r.kind='org_stats'
      AND NOT EXISTS (SELECT 1 FROM succession_calc_run_objects o WHERE o.tenant_id=r.tenant_id AND o.run_id=r.id
        AND NOT (${scopeSql(scope, { org: sql`o.object_id` })}))`),
    );
    if (views.length !== ids.length) throw new AppError('NOT_FOUND', '统计任务不存在');
    return { views, revisions: new Map(views.map((v) => [v.id, 1])) };
  },
  project: async (_deps, _ctx, views) => [...views],
};
async function savePreferences(
  tx: Tx,
  ctx: SuccessionContext,
  kind: MapKind,
  body: MapPreferences,
  expected: number,
  scope: Parameters<typeof scopeSql>[0],
) {
  const initial = await readPreferences(tx, ctx.tenantId, ctx.userId, kind);
  const created = rowsOf(
    await tx.execute(sql`INSERT INTO succession_map_preferences (tenant_id,user_id,map_kind,depth)
    VALUES (${ctx.tenantId}::uuid,${ctx.userId}::uuid,${kind},${initial.depth})
    ON CONFLICT DO NOTHING RETURNING user_id`),
  );
  await tx.execute(sql`SELECT revision FROM succession_map_preferences
    WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND map_kind=${kind} FOR UPDATE`);
  // 仅由本事务真正插入的占位行按 0 比较；并发败者须重读获胜者的 revision，不能把它当未保存。
  const before = await readPreferences(tx, ctx.tenantId, ctx.userId, kind);
  const actual = created.length ? 0 : before.revision;
  if (actual !== expected) throw new AppError('REVISION_CONFLICT', '显示设置已变更，请刷新后重提');
  const next = actual + 1;
  await tx.execute(sql`UPDATE succession_map_preferences SET root_org_id=${body.rootOrgId}::uuid,depth=${body.depth},
    hidden_org_ids=${JSON.stringify(body.hiddenOrgIds)}::jsonb,
    show_key_positions=${body.showKeyPositions},show_positions_without_successor=${body.showPositionsWithoutSuccessor},
    revision=${next}
    WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND map_kind=${kind}`);
  const after = await readPreferences(tx, ctx.tenantId, ctx.userId, kind);
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    objectType: codeOf('map'),
    objectId: after.id,
    action: 'succession.map.preferences',
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    before: created.length ? null : before,
    after: { ...after, userId: ctx.userId },
  });
  if (
    actual === 0 ||
    Object.entries(body).some(
      ([key, value]) => JSON.stringify(before[key as keyof MapPreferences]) !== JSON.stringify(value),
    )
  ) {
    const ids = await readMapDisplayScope(tx, { ...ctx, scope, asOf: tenantLocalDate(ctx.now, ctx.timezone) }, 'org');
    await enqueueCalcRun(
      tx,
      {
        tenantId: ctx.tenantId,
        kind: 'org_stats',
        trigger: 'preferences_change',
        commandId: ctx.commandId,
        requestedBy: ctx.userId,
        businessDate: tenantLocalDate(ctx.now, ctx.timezone),
        preferencesRevision: next,
        objects: ids.map((objectId) => ({ objectType: 'org', objectId })),
      },
      ctx.now,
    );
  }
  return after.id;
}
export function registerMapRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(PREFS, async (c) => {
    const ctx = await successionContext(c, deps, 'map');
    const kind = mapKind(c.req.param('kind'));
    const { id: _id, ...view } = await withTenant(deps.db, ctx.tenantId, (tx) =>
      readPreferences(tx, ctx.tenantId, ctx.userId, kind),
    );
    c.header('ETag', `"${view.revision}"`);
    return c.json(view);
  });
  const writeMap = async (c: Context<TenantEnv>, compute: boolean) => {
    const ctx = await successionContext(c, deps, 'map');
    if (compute) await button(deps, ctx, codeOf('map'), 'computeStats', 'list');
    const kind = compute ? 'org' : mapKind(c.req.param('kind'));
    const expected = revision(c);
    const body = compute ? await parseBody(c, mapDisplayBody) : await parseBody(c, preferenceBody);
    if (compute) requireNew(expected);
    const results: ResultAdapter = compute ? statsResults : preferenceResults;
    const response = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: expected, body },
      guard: {
        before: async (tx) => {
          // ledgerExit 在查台账前只复核当前授权，不能把首次引用启用性门槛重新施加给原命令。
          await mapAccess(c, deps, tx, compute);
        },
        replayed: async (tx, stored) => {
          await results.load(tx, deps, ctx, (stored.body as StoredResult).ids, { includeDeleted: false });
        },
      },
      execute: async (tx, commandId) => {
        const { scope } = await mapAccess(c, deps, tx, compute);
        const asOf = tenantLocalDate(ctx.now, ctx.timezone);
        // 只有未命中台账的实际首次执行才校验新条件；直接重放和失败回查都走结果适配器。
        if (!compute) await resolveMapDisplayConditions(tx, { ...ctx, scope, asOf }, kind, body, 'submitted');
        const id = compute
          ? await enqueueCalcRun(
              tx,
              {
                tenantId: ctx.tenantId,
                kind: 'org_stats',
                trigger: 'manual',
                requestedBy: ctx.userId,
                commandId,
                businessDate: asOf,
                objects: (await readMapDisplayScope(tx, { ...ctx, scope, asOf }, 'org', body, 'submitted')).map(
                  (objectId) => ({
                    objectType: 'org',
                    objectId,
                  }),
                ),
              },
              ctx.now,
            )
          : await savePreferences(tx, { ...ctx, commandId }, kind, body as MapPreferences, expected, scope);
        return { status: compute ? 202 : 200, body: { kind: 'record', ids: [id], commandId } satisfies StoredResult };
      },
    });
    const result = await authorizeSuccessionResult(deps, ctx, response.body as StoredResult, results);
    if (compute) return c.json({ runId: (response.body as StoredResult).ids[0] }, 202);
    c.header('ETag', `"${result.revisions.get((response.body as StoredResult).ids[0]!)}"`);
    return c.json(result.items[0], 200);
  };
  router.put(PREFS, (c) => writeMap(c, false));
  router.post(STATS, (c) => writeMap(c, true));
}
