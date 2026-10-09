/**
 * R3-T02 PR-B 人才评定配置接口（docs/02_业务建模/24；设计 §3.2、§5；路由声明见
 * docs/08_设计/R3-T02-B1a_评定底座与活动类型_路由声明.md）。挂在 /api/tenant/evaluation/ 之下。
 * 通用 CRUD 注册器 `registerObject`（B1a 建立，B1b 的周期 / 通用评分项复用，B3～B5 的带所属组织对象扩展）：
 * 写入走命令台账（幂等、revision 409），首次执行与幂等重放都按当前功能权限、按钮与范围复核。
 * B1a：活动类型 activity-types。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { booleanQuery, pageQuery, parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import * as activityTypes from './activity-type-service.js';
import {
  checkWriteFields,
  type EvaluationObject,
  evaluationContext,
  evaluationScope,
  evaluationWriteContext,
  listEnvelope,
  requireVisible,
  scopePredicate,
} from './access.js';
import * as input from './input.js';
import * as read from './read-model.js';
import { EV_BASE, presenter, runWrite, type View, writeContext } from './route-support.js';
import { rowAccess, type WriteContext } from './store.js';

export { EV_BASE };

interface ObjectRoutes<Create, Patch> {
  readonly object: EvaluationObject;
  readonly path: string;
  readonly createSchema: z.ZodType<Create>;
  readonly patchSchema: z.ZodType<Patch>;
  readonly filter?: (c: Context) => SQL;
  create(tx: Tx, ctx: WriteContext, body: Create): Promise<View>;
  update(tx: Tx, ctx: WriteContext, id: string, body: Patch): Promise<View>;
  remove(tx: Tx, ctx: WriteContext, id: string): Promise<View>;
}

const eq = (column: string, value: string | boolean | undefined) =>
  value === undefined ? sql`true` : sql`${sql.identifier('t')}.${sql.identifier(column)} = ${value}`;

const SPECS = {
  activityType: {
    object: 'activityType',
    path: 'activity-types',
    createSchema: input.activityTypeCreate,
    patchSchema: input.activityTypePatch,
    filter: (c: Context) => eq('enabled', booleanQuery(c, 'enabled')),
    create: activityTypes.createActivityType,
    update: activityTypes.updateActivityType,
    remove: activityTypes.deleteActivityType,
  } satisfies ObjectRoutes<input.ActivityTypeCreate, input.ActivityTypePatch>,
} as const;

export function registerEvaluationRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  for (const spec of Object.values(SPECS)) registerObject(router, deps, spec as ObjectRoutes<object, object>);
}

function registerObject<Create extends object, Patch extends object>(
  router: Hono<TenantEnv>,
  deps: TenantRouteDeps,
  spec: ObjectRoutes<Create, Patch>,
) {
  const path = `${EV_BASE}/${spec.path}`;
  const present = presenter(deps, spec.object);
  router.get(path, async (c) => {
    const ctx = await evaluationContext(c, deps, spec.object);
    const page = pageQuery(c);
    const scope = await evaluationScope(c, deps, ctx, spec.object);
    const filter = spec.filter?.(c) ?? sql`true`;
    const rows = await withTenant(deps.db, ctx.tenantId, (tx) =>
      read.listRows(tx, ctx.tenantId, spec.object, scopePredicate(scope, spec.object), page, filter),
    );
    return c.json({
      ...listEnvelope(page, scope),
      items: await present(
        ctx,
        rows.map((row) => read.view<View>(row)),
      ),
    });
  });
  router.get(`${path}/:id`, async (c) => {
    const ctx = await evaluationContext(c, deps, spec.object);
    const id = uuidParam(c);
    const scope = await evaluationScope(c, deps, ctx, spec.object);
    const found = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      requireVisible((await rowAccess(tx, ctx, scope, spec.object, id)).visible, spec.object);
      return read.view<View>((await read.loadRow(tx, ctx.tenantId, spec.object, id))!);
    });
    c.header('ETag', `"${found.revision}"`);
    return c.json((await present(ctx, [found]))[0]);
  });
  router.post(path, async (c) => {
    const ctx = await evaluationWriteContext(c, deps, spec.object, 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, spec.createSchema);
    await checkWriteFields(deps, ctx, spec.object, 'create', body as Record<string, unknown>);
    const w = writeContext(ctx, await evaluationScope(c, deps, ctx, spec.object));
    return runWrite(c, deps, w, spec.object, body, 201, (tx, x) => spec.create(tx, x, body) as Promise<View>);
  });
  router.patch(`${path}/:id`, async (c) => {
    const ctx = await evaluationWriteContext(c, deps, spec.object, 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, spec.patchSchema);
    await checkWriteFields(deps, ctx, spec.object, 'update', body as Record<string, unknown>);
    const w = writeContext(ctx, await evaluationScope(c, deps, ctx, spec.object));
    return runWrite(c, deps, w, spec.object, body, 200, (tx, x) => spec.update(tx, x, id, body) as Promise<View>);
  });
  router.delete(`${path}/:id`, async (c) => {
    const ctx = await evaluationWriteContext(c, deps, spec.object, 'delete', revision(c));
    const id = uuidParam(c);
    const w = writeContext(ctx, await evaluationScope(c, deps, ctx, spec.object));
    return runWrite(c, deps, w, spec.object, { id }, 200, (tx, x) => spec.remove(tx, x, id) as Promise<View>);
  });
}
