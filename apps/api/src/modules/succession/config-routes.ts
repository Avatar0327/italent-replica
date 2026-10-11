/** #13 / #14：租户配置入口；写命令三条返回路径统一走 A2 的授权结果出口。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import type { Context, Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { AppError } from '../../errors.js';
import { pageQuery, parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import { successionContext, SUCCESSION_BASE } from './access.js';
import {
  configAccess,
  configResults,
  missing,
  populationViews,
  projectConfig,
  settingsView,
  type ConfigView,
} from './config-store.js';
import { mutatePopulation, updateColor } from './config-write.js';
import { colorBody, populationBody, populationPatch, ruleKind } from './population-input.js';
import { rowsOf } from './read-sql.js';
import { authorizeSuccessionResult, checkWriteAccess, runSuccessionCommand, type WriteSpec } from './write-support.js';

const POPULATIONS = `${SUCCESSION_BASE}/populations`;
const SETTINGS = `${SUCCESSION_BASE}/rule-settings/:kind`;
function kindOf(c: Context<TenantEnv>) {
  const parsed = ruleKind.safeParse(c.req.param('kind'));
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '规则类型不合法');
  return parsed.data;
}
export async function writeConfig(c: Context<TenantEnv>, deps: TenantRouteDeps, spec: WriteSpec<ConfigView>) {
  const ctx = await checkWriteAccess(c, deps, { ...spec, object: spec.results.object });
  await withTenant(deps.db, ctx.tenantId, (tx) =>
    configAccess(tx, deps, ctx, spec.results.object as 'population' | 'ruleSettings'),
  );
  const { status, result } = await runSuccessionCommand(c, deps, ctx, spec);
  const { items, revisions } = await authorizeSuccessionResult(deps, ctx, result, spec.results);
  if (result.kind === 'receipt') return c.json({ id: result.ids[0], deleted: true }, status);
  c.header('ETag', `"${revisions.get(result.ids[0]!)}"`);
  return c.json(items[0], status);
}
function registerPopulationWrites(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post(POPULATIONS, async (c) => {
    const body = await parseBody(c, populationBody);
    const expectedRevision = revision(c);
    requireNew(expectedRevision);
    const id = randomUUID();
    return writeConfig(c, deps, {
      operation: 'create',
      button: { code: 'create', level: 'list' },
      expectedRevision,
      payload: body,
      input: body,
      status: 201,
      results: configResults('population'),
      execute: (tx, ctx) => mutatePopulation(tx, deps, ctx, 'create', id, body),
    });
  });
  router.put(`${POPULATIONS}/:id`, async (c) => {
    const id = uuidParam(c);
    const body = await parseBody(c, populationPatch);
    return writeConfig(c, deps, {
      operation: 'update',
      button: { code: 'update', level: 'detail' },
      expectedRevision: revision(c),
      payload: body,
      input: { id, body },
      status: 200,
      results: configResults('population'),
      execute: (tx, ctx) => mutatePopulation(tx, deps, ctx, 'update', id, body),
    });
  });
  router.delete(`${POPULATIONS}/:id`, async (c) => {
    const id = uuidParam(c);
    return writeConfig(c, deps, {
      operation: 'delete',
      button: { code: 'delete', level: 'detail' },
      expectedRevision: revision(c),
      input: { id },
      status: 200,
      results: configResults('population'),
      execute: (tx, ctx) => mutatePopulation(tx, deps, ctx, 'delete', id),
    });
  });
}
export function registerSuccessionConfigRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerPopulationWrites(router, deps);
  router.get(POPULATIONS, async (c) => {
    const ctx = await successionContext(c, deps, 'population');
    const page = pageQuery(c);
    const result = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      await configAccess(tx, deps, ctx, 'population');
      const ids = rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT id FROM succession_populations
        WHERE tenant_id = ${ctx.tenantId}::uuid ORDER BY display_order, id LIMIT ${page.limit} OFFSET ${page.offset}`),
      );
      const [count] = rowsOf<{ total: number }>(
        await tx.execute(sql`SELECT count(*)::int AS total
        FROM succession_populations WHERE tenant_id = ${ctx.tenantId}::uuid`),
      );
      return {
        total: count!.total,
        items: await populationViews(
          tx,
          ctx.tenantId,
          ids.map((row) => row.id),
        ),
      };
    });
    return c.json({
      page: page.page,
      pageSize: page.pageSize,
      total: result.total,
      items: await projectConfig(deps, ctx, 'population', result.items),
    });
  });
  router.get(`${POPULATIONS}/:id`, async (c) => {
    const ctx = await successionContext(c, deps, 'population');
    const id = uuidParam(c);
    const [view] = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      await configAccess(tx, deps, ctx, 'population');
      return populationViews(tx, ctx.tenantId, [id]);
    });
    if (!view) throw missing();
    c.header('ETag', `"${view.revision}"`);
    return c.json((await projectConfig(deps, ctx, 'population', [view]))[0]);
  });
  router.get(SETTINGS, async (c) => {
    const kind = kindOf(c);
    const ctx = await successionContext(c, deps, 'ruleSettings');
    const view = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      await configAccess(tx, deps, ctx, 'ruleSettings');
      return settingsView(tx, ctx.tenantId, kind);
    });
    c.header('ETag', `"${view.revision}"`);
    return c.json((await projectConfig(deps, ctx, 'ruleSettings', [view]))[0]);
  });
  router.put(SETTINGS, async (c) => {
    const kind = kindOf(c);
    const body = await parseBody(c, colorBody);
    return writeConfig(c, deps, {
      operation: 'update',
      button: { code: 'update', level: 'detail' },
      expectedRevision: revision(c),
      input: { kind, body },
      payload: body,
      status: 200,
      results: configResults('ruleSettings'),
      execute: (tx, ctx) => updateColor(tx, deps, ctx, kind, body.defaultColor),
    });
  });
}
