/** #11 / #12：规则正文与赋值选项使用各自的权限对象，所有写入口复用 A2 的命令与授权结果出口。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Tx } from '@italent/db';
import type { SuccessionLevelKind, SuccessionLevelRules } from '@italent/domain';
import type { Context, Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { AppError } from '../../errors.js';
import { button } from '../permission/module-route-access.js';
import { pageQuery, parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import { codeOf, successionContext, SUCCESSION_BASE, type SuccessionContext } from './access.js';
import { configAccess, missing, projectConfig } from './config-store.js';
import { levelOrder, levelSchemas } from './levels-input.js';
import { levelResults, levelSpec, levelViews, listLevels, type LevelView } from './levels-store.js';
import { mutateLevel, reorderLevels } from './levels-write.js';
import { requireSupportedHealthChange, type HealthLevelChange } from './health-rule-support.js';
import { rowsOf } from './read-sql.js';
import { authorizeSuccessionResult, checkWriteAccess, runSuccessionCommand, type WriteSpec } from './write-support.js';

async function writeLevels(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  spec: WriteSpec<LevelView>,
  change?: { readonly id?: string; readonly body: HealthLevelChange },
) {
  const object = spec.results.object as 'riskLevel' | 'healthLevel';
  const ctx = await checkWriteAccess(c, deps, { ...spec, object });
  const validate = async (tx: Tx, current: SuccessionContext) => {
    await configAccess(tx, deps, current, object);
    if (object !== 'healthLevel' || !change) return;
    // DEC-466：入口和台账前各读当前规则；持锁更新仍须使用锁内版本再验。
    let inheritedRules: SuccessionLevelRules | null | undefined;
    if (change.id && change.body.enabled === true && change.body.rules === undefined) {
      const [before] = await levelViews(tx, current.tenantId, 'health', [change.id]);
      if (!before) throw missing();
      inheritedRules = before.rules;
    }
    requireSupportedHealthChange(change.body, inheritedRules);
  };
  await withTenant(deps.db, ctx.tenantId, (tx) => validate(tx, ctx));
  const { status, result } = await runSuccessionCommand(c, deps, ctx, {
    ...spec,
    beforeCommand: object === 'healthLevel' && change ? validate : undefined,
  });
  const { items, revisions } = await authorizeSuccessionResult(deps, ctx, result, spec.results);
  if (result.kind === 'receipt') return c.json({ id: result.ids[0], deleted: true }, status);
  if (result.kind === 'records') return c.json({ items }, status);
  c.header('ETag', `"${revisions.get(result.ids[0]!)}"`);
  return c.json(items[0], status);
}
export async function levelOptionAccess(c: Context<TenantEnv>, deps: TenantRouteDeps, kind: SuccessionLevelKind) {
  const object = kind === 'risk' ? 'riskResult' : 'healthResult';
  const ctx = await successionContext(c, deps, object, 'update');
  try {
    await button(deps, ctx, codeOf(object), 'assign', 'detail');
  } catch (error) {
    if (kind !== 'health' || !(error instanceof AppError) || error.code !== 'FORBIDDEN') throw error;
    await button(deps, ctx, codeOf(object), 'reset', 'list');
  }
  return ctx;
}
function registerLevelReads(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  for (const kind of ['risk', 'health'] as const) {
    const spec = levelSpec(kind);
    router.get(`${SUCCESSION_BASE}/${kind}-levels/options`, async (c) => {
      const ctx = await levelOptionAccess(c, deps, kind);
      const items = await withTenant(deps.db, ctx.tenantId, async (tx) =>
        rowsOf(
          await tx.execute(sql`
        SELECT id, code, name, color, enabled FROM ${spec.table} WHERE tenant_id = ${ctx.tenantId}::uuid
          AND enabled ORDER BY display_order, id`),
        ),
      );
      return c.json({ items });
    });
    router.get(`${SUCCESSION_BASE}/${kind}-levels`, async (c) => {
      const ctx = await successionContext(c, deps, spec.object);
      const page = pageQuery(c);
      const found = await withTenant(deps.db, ctx.tenantId, async (tx) => {
        await configAccess(tx, deps, ctx, spec.object);
        return listLevels(tx, ctx.tenantId, kind, page);
      });
      c.header('ETag', `"${found.collectionRevision}"`);
      return c.json({
        page: page.page,
        pageSize: page.pageSize,
        total: found.total,
        collectionRevision: found.collectionRevision,
        items: await projectConfig(deps, ctx, spec.object, found.items),
      });
    });
    router.get(`${SUCCESSION_BASE}/${kind}-levels/:id`, async (c) => {
      const ctx = await successionContext(c, deps, spec.object);
      const id = uuidParam(c);
      const [view] = await withTenant(deps.db, ctx.tenantId, async (tx) => {
        await configAccess(tx, deps, ctx, spec.object);
        return levelViews(tx, ctx.tenantId, kind, [id]);
      });
      if (!view) throw missing();
      c.header('ETag', `"${view.revision}"`);
      return c.json((await projectConfig(deps, ctx, spec.object, [view]))[0]);
    });
  }
}
export function registerSuccessionLevelRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerLevelReads(router, deps);
  for (const kind of ['risk', 'health'] as const) {
    router.post(`${SUCCESSION_BASE}/${kind}-levels`, async (c) => {
      const body = await parseBody(c, levelSchemas(kind).create);
      const expectedRevision = revision(c);
      requireNew(expectedRevision);
      return writeLevels(
        c,
        deps,
        {
          operation: 'create',
          button: { code: 'create', level: 'list' },
          expectedRevision,
          payload: body,
          input: body,
          status: 201,
          results: levelResults(kind),
          execute: (tx, ctx) => mutateLevel(tx, deps, ctx, kind, 'create', randomUUID(), body),
        },
        { body },
      );
    });
    // 静态 order 路由先于 :id 写入口，不能把重排请求当作 UUID。
    router.put(`${SUCCESSION_BASE}/${kind}-levels/order`, async (c) => {
      const body = await parseBody(c, levelOrder);
      return writeLevels(c, deps, {
        operation: 'update',
        button: { code: 'reorder', level: 'list' },
        expectedRevision: revision(c),
        payload: { displayOrder: body.ids },
        input: body,
        status: 200,
        results: levelResults(kind),
        execute: (tx, ctx) => reorderLevels(tx, deps, ctx, kind, body.ids),
      });
    });
    router.put(`${SUCCESSION_BASE}/${kind}-levels/:id`, async (c) => {
      const id = uuidParam(c);
      const body = await parseBody(c, levelSchemas(kind).patch);
      return writeLevels(
        c,
        deps,
        {
          operation: 'update',
          button: { code: 'update', level: 'detail' },
          expectedRevision: revision(c),
          payload: body,
          input: { id, body },
          status: 200,
          results: levelResults(kind),
          execute: (tx, ctx) => mutateLevel(tx, deps, ctx, kind, 'update', id, body),
        },
        { id, body },
      );
    });
    router.delete(`${SUCCESSION_BASE}/${kind}-levels/:id`, async (c) => {
      const id = uuidParam(c);
      return writeLevels(c, deps, {
        operation: 'delete',
        button: { code: 'delete', level: 'detail' },
        expectedRevision: revision(c),
        input: { id },
        status: 200,
        results: levelResults(kind),
        execute: (tx, ctx) => mutateLevel(tx, deps, ctx, kind, 'delete', id),
      });
    });
  }
}
