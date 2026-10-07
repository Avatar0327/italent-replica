/**
 * R3-T01 人才标准与指标库接口（docs/02_业务建模/23 §2；REQ-TC-001）。挂在 /api/tenant/talent/ 之下：
 * 指标库 libraries、指标 dimensions、人才标准分类 criterion-categories、人才标准 criteria，以及新建 / 编辑人才标准时的
 * 可引用指标候选 candidates/dimensions（TC-R4）。写入走命令台账（幂等、revision 409），首次执行与幂等重放都按当前范围复核。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { hasCreatorScope } from '../permission/module-route-access.js';
import {
  checkWriteFields,
  codeOf,
  nestedDimensionReader,
  requireVisible,
  talentContext,
  talentScope,
  trimTalentList,
  visibleSql,
  type ModuleScope,
  type TalentContext,
  type TalentObject,
} from './access.js';
import {
  booleanQuery,
  nameQuery,
  pageQuery,
  parseBody,
  requireNew,
  revision,
  typeQuery,
  uuidParam,
  uuidQuery,
} from './http.js';
import * as input from './input.js';
import * as read from './read-model.js';
import * as write from './service.js';

const BASE = '/api/tenant/talent';

interface Tracked {
  readonly id: string;
  readonly createdBy: string;
  readonly revision: number;
}

interface ObjectRoutes<View extends Tracked, Create, Patch> {
  readonly object: TalentObject;
  readonly path: string;
  readonly table: string;
  readonly createSchema: z.ZodType<Create>;
  readonly patchSchema: z.ZodType<Patch>;
  /** 写入时引用的其他对象（须各自可见）。 */
  readonly references: (body: Create | Patch) => readonly TalentObject[];
  list(tx: Tx, tenantId: string, c: Context, page: read.Page, visible: SQL): Promise<View[]>;
  load(tx: Tx, tenantId: string, id: string): Promise<View | undefined>;
  create(tx: Tx, ctx: write.WriteContext, body: Create): Promise<View>;
  update(tx: Tx, ctx: write.WriteContext, id: string, body: Patch): Promise<View>;
  remove(tx: Tx, ctx: write.WriteContext, id: string): Promise<View>;
}

const creatorOf = (table: string) => sql`${sql.identifier(table)}.created_by`;

const LIBRARIES: ObjectRoutes<read.LibraryView, input.LibraryCreate, input.LibraryPatch> = {
  object: 'library',
  path: 'libraries',
  table: 'talent_dimension_libraries',
  createSchema: input.libraryCreate,
  patchSchema: input.libraryPatch,
  references: () => [],
  list: (tx, tenantId, c, page, visible) =>
    read.listLibraries(tx, tenantId, { ...page, type: typeQuery(c), enabled: booleanQuery(c, 'enabled'), visible }),
  load: read.loadLibrary,
  create: write.createLibrary,
  update: write.updateLibrary,
  remove: write.deleteLibrary,
};

const DIMENSIONS: ObjectRoutes<read.DimensionView, input.DimensionCreate, input.DimensionPatch> = {
  object: 'dimension',
  path: 'dimensions',
  table: 'talent_dimensions',
  createSchema: input.dimensionCreate,
  patchSchema: input.dimensionPatch,
  references: (body) => ('libraryId' in body ? ['library'] : []),
  list: (tx, tenantId, c, page, visible) =>
    read.listDimensions(tx, tenantId, {
      ...page,
      libraryId: uuidQuery(c, 'libraryId'),
      type: typeQuery(c),
      enabled: booleanQuery(c, 'enabled'),
      name: nameQuery(c),
      visible,
    }),
  load: read.loadDimension,
  create: write.createDimension,
  update: write.updateDimension,
  remove: write.deleteDimension,
};

const CATEGORIES: ObjectRoutes<read.CategoryView, input.CategoryCreate, input.CategoryPatch> = {
  object: 'criterionCategory',
  path: 'criterion-categories',
  table: 'talent_criterion_categories',
  createSchema: input.categoryCreate,
  patchSchema: input.categoryPatch,
  references: () => [],
  list: (tx, tenantId, _c, page, visible) => read.listCategories(tx, tenantId, { ...page, visible }),
  load: read.loadCategory,
  create: write.createCategory,
  update: write.updateCategory,
  remove: write.deleteCategory,
};

const CRITERIA: ObjectRoutes<read.CriterionView, input.CriterionCreate, input.CriterionPatch> = {
  object: 'criterion',
  path: 'criteria',
  table: 'talent_criteria',
  createSchema: input.criterionCreate,
  patchSchema: input.criterionPatch,
  references: (body) => [
    ...(body.categoryId !== undefined ? (['criterionCategory'] as const) : []),
    ...(body.dimensions?.length ? (['dimension'] as const) : []),
  ],
  list: (tx, tenantId, c, page, visible) =>
    read.listCriteria(tx, tenantId, {
      ...page,
      categoryId: uuidQuery(c, 'categoryId'),
      enabled: booleanQuery(c, 'enabled'),
      name: nameQuery(c),
      visible,
    }),
  load: read.loadCriterion,
  create: write.createCriterion,
  update: write.updateCriterion,
  remove: write.deleteCriterion,
};

export function registerTalentRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerCandidates(router, deps);
  registerObject(router, deps, LIBRARIES);
  registerObject(router, deps, DIMENSIONS);
  registerObject(router, deps, CATEGORIES);
  registerObject(router, deps, CRITERIA);
}

/** 新建 / 编辑人才标准时的可引用指标：指标与指标库都已启用（TC-R4），按查看人的指标范围与字段权限。 */
function registerCandidates(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${BASE}/candidates/dimensions`, async (c) => {
    const ctx = await talentContext(c, deps, 'dimension');
    const page = pageQuery(c);
    const scope = await talentScope(c, deps, ctx, 'dimension');
    const query = { ...page, type: typeQuery(c), name: nameQuery(c), referenceable: true };
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      read.listDimensions(tx, ctx.tenantId, { ...query, visible: visibleSql(scope, creatorOf('talent_dimensions')) }),
    );
    return c.json({ ...listEnvelope(page, scope), items: await trimTalentList(deps, ctx, 'dimension', items) });
  });
}

function registerObject<View extends Tracked, Create extends object, Patch extends object>(
  router: Hono<TenantEnv>,
  deps: TenantRouteDeps,
  spec: ObjectRoutes<View, Create, Patch>,
) {
  const path = `${BASE}/${spec.path}`;
  const present = presenter(deps, spec.object);
  router.get(path, async (c) => {
    const ctx = await talentContext(c, deps, spec.object);
    const page = pageQuery(c);
    const scope = await talentScope(c, deps, ctx, spec.object);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      spec.list(tx, ctx.tenantId, c, page, visibleSql(scope, creatorOf(spec.table))),
    );
    const shown = await present(c, ctx, items);
    return c.json({ ...listEnvelope(page, scope), items: shown });
  });
  router.get(`${path}/:id`, async (c) => {
    const ctx = await talentContext(c, deps, spec.object);
    const id = uuidParam(c);
    const scope = await talentScope(c, deps, ctx, spec.object);
    const found = await withTenant(deps.db, ctx.tenantId, (tx) => spec.load(tx, ctx.tenantId, id));
    if (!found) throw new AppError('NOT_FOUND', '对象不存在');
    requireVisible(scope, spec.object, found.createdBy);
    c.header('ETag', `"${found.revision}"`);
    return c.json((await present(c, ctx, [found]))[0]);
  });
  router.post(path, async (c) => {
    const ctx = await talentContext(c, deps, spec.object, 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, spec.createSchema);
    await checkWriteFields(deps, ctx, spec.object, 'create', body as Record<string, unknown>);
    return runTalentWrite(c, deps, ctx, spec, body, 201, (tx, w) => spec.create(tx, w, body));
  });
  router.patch(`${path}/:id`, async (c) => {
    const ctx = await talentContext(c, deps, spec.object, 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, spec.patchSchema);
    await checkWriteFields(deps, ctx, spec.object, 'update', body as Record<string, unknown>);
    return runTalentWrite(c, deps, ctx, spec, body, 200, (tx, w) => spec.update(tx, w, id, body));
  });
  router.delete(`${path}/:id`, async (c) => {
    const ctx = await talentContext(c, deps, spec.object, 'delete', revision(c));
    const id = uuidParam(c);
    return runTalentWrite(c, deps, ctx, spec, { id }, 200, (tx, w) => spec.remove(tx, w, id));
  });
}

/**
 * 命令执行：范围与引用对象的范围在事务外按当前权限解析；首次执行在事务内逐个复核（行锁之后），
 * 幂等重放按当前范围复核结果对象（撤权后重放 404，AGENTS §10）。响应按当前字段权限裁剪。
 */
async function runTalentWrite<View extends Tracked, Create, Patch>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentContext,
  spec: ObjectRoutes<View, Create, Patch>,
  body: object,
  status: 200 | 201,
  execute: (tx: Tx, ctx: write.WriteContext) => Promise<View>,
) {
  const scope = await talentScope(c, deps, ctx, spec.object);
  const references: Record<string, ModuleScope | null> = {};
  for (const object of spec.references(body as Create | Patch)) {
    references[object] = await referenceScope(c, deps, ctx, object);
  }
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input: body },
    execute: async (tx, commandId) => ({
      status,
      body: await execute(tx, { ...ctx, commandId, scope, references }),
    }),
  });
  const view = result.body as View;
  requireVisible(scope, spec.object, view.createdBy);
  if (c.req.method !== 'DELETE') c.header('ETag', `"${view.revision}"`);
  return c.json((await presenter(deps, spec.object)(c, ctx, [view]))[0], result.status);
}

async function referenceScope(c: Context<TenantEnv>, deps: TenantRouteDeps, ctx: TalentContext, object: TalentObject) {
  const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf(object), fields: [] });
  return canView ? talentScope(c, deps, ctx, object) : null;
}

/** 按字段权限裁剪；人才标准里嵌套的指标内容另按指标对象的查看权、范围与字段权限。 */
function presenter(deps: TenantRouteDeps, object: TalentObject) {
  return async <T extends object>(c: Context<TenantEnv>, ctx: TalentContext, items: T[]) => {
    if (object !== 'criterion') return trimTalentList(deps, ctx, object, items);
    const nested = await nestedDimensionReader(c, deps, ctx);
    const shaped = (items as unknown as read.CriterionView[]).map((item) => ({
      ...item,
      dimensions: item.dimensions.map(({ dimension, ...reference }) => {
        const visible = nested(dimension);
        return visible ? { ...reference, dimension: visible } : reference;
      }),
    }));
    return trimTalentList(deps, ctx, object, shaped);
  };
}

function listEnvelope(page: { page: number; pageSize: number }, scope: ModuleScope) {
  return { page: page.page, pageSize: page.pageSize, hasDataPermission: scope.all || hasCreatorScope(scope) };
}
