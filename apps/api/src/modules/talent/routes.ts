/**
 * R3-T01 人才标准与指标库接口（docs/02_业务建模/23 §2、§7；REQ-TC-001；DEC-281）。挂在 /api/tenant/talent/ 之下：
 * 指标库 libraries、指标库内分类 dimension-categories、发展建议类型 description-types、指标 dimensions、
 * 人才标准分类 criterion-categories、人才标准 criteria，以及候选：可引用指标 candidates/dimensions（TC-R4）、
 * 发展建议类型下拉 candidates/description-types、创建人的授权管理单元 candidates/owner-orgs（DEC-294③），
 * 以及人才标准的「设置指标类别」criteria/:id/dimension-category（DEC-294⑤）。
 * 写入走命令台账（幂等、revision 409），首次执行与幂等重放都按当前功能权限、按钮与范围复核。
 */
import { withTenant, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  checkWriteFields,
  codeOf,
  listEnvelope,
  nestedDimensionReader,
  type Owner,
  requireVisible,
  scopeColumns,
  talentContext,
  talentScope,
  TALENT_LABELS,
  talentWriteContext,
  trimTalentList,
  viewableFields,
  visibleSql,
  type ModuleScope,
  type TalentContext,
  type TalentObject,
} from './access.js';
import { registerCandidates } from './candidates.js';
import * as criteria from './criterion-service.js';
import * as dimensions from './dimension-service.js';
import {
  booleanQuery,
  nameQuery,
  pageQuery,
  parseBody,
  requireNew,
  revision,
  TALENT_BASE,
  typeQuery,
  uuidParam,
  uuidQuery,
} from './http.js';
import * as input from './input.js';
import * as libraries from './library-service.js';
import * as read from './read-model.js';
import { registerModelImageRoutes } from './model-image-routes.js';
import type { ReferenceFields, WriteContext } from './write-support.js';

interface Tracked {
  readonly id: string;
  readonly revision: number;
}

interface ObjectRoutes<View extends Tracked, Create, Patch> {
  readonly object: TalentObject;
  readonly path: string;
  readonly table: string;
  readonly createSchema: z.ZodType<Create>;
  readonly patchSchema: z.ZodType<Patch>;
  /** 范围锚点：所属管理单元与所属人；字典只有创建人。 */
  owner(view: View): Owner;
  /** 写入时引用的其他对象（须各自可见）。 */
  references(body: Create | Patch): readonly TalentObject[];
  list(tx: Tx, tenantId: string, c: Context, page: read.Page, visible: SQL): Promise<View[]>;
  load(tx: Tx, tenantId: string, id: string): Promise<View | undefined>;
  create(tx: Tx, ctx: WriteContext, body: Create): Promise<View>;
  update(tx: Tx, ctx: WriteContext, id: string, body: Patch): Promise<View>;
  remove(tx: Tx, ctx: WriteContext, id: string): Promise<View>;
}

const ownedBy = (view: { ownerOrgId: string; ownerId: string }): Owner => ({
  orgId: view.ownerOrgId,
  ownerId: view.ownerId,
});

const LIBRARIES: ObjectRoutes<read.LibraryView, input.LibraryCreate, input.LibraryPatch> = {
  object: 'library',
  path: 'libraries',
  table: 'talent_dimension_libraries',
  createSchema: input.libraryCreate,
  patchSchema: input.libraryPatch,
  owner: ownedBy,
  references: () => [],
  list: (tx, tenantId, c, page, visible) =>
    read.listLibraries(tx, tenantId, { ...page, type: typeQuery(c), enabled: booleanQuery(c, 'enabled'), visible }),
  load: read.loadLibrary,
  create: libraries.createLibrary,
  update: libraries.updateLibrary,
  remove: libraries.deleteLibrary,
};

const DIMENSION_CATEGORIES: ObjectRoutes<
  read.DimensionCategoryView,
  input.DimensionCategoryCreate,
  input.DimensionCategoryPatch
> = {
  object: 'dimensionCategory',
  path: 'dimension-categories',
  table: 'talent_dimension_categories',
  createSchema: input.dimensionCategoryCreate,
  patchSchema: input.dimensionCategoryPatch,
  owner: ownedBy,
  references: (body) => ('libraryId' in body ? ['library'] : []),
  list: (tx, tenantId, c, page, visible) =>
    read.listDimensionCategories(tx, tenantId, { ...page, libraryId: uuidQuery(c, 'libraryId'), visible }),
  load: read.loadDimensionCategory,
  create: libraries.createDimensionCategory,
  update: libraries.updateDimensionCategory,
  remove: libraries.deleteDimensionCategory,
};

const DESCRIPTION_TYPES: ObjectRoutes<
  read.DescriptionTypeView,
  input.DescriptionTypeCreate,
  input.DescriptionTypePatch
> = {
  object: 'descriptionType',
  path: 'description-types',
  table: 'talent_description_types',
  createSchema: input.descriptionTypeCreate,
  patchSchema: input.descriptionTypePatch,
  owner: (view) => ({ ownerId: view.createdBy }),
  references: () => [],
  list: (tx, tenantId, c, page, visible) =>
    read.listDescriptionTypes(tx, tenantId, { ...page, enabled: booleanQuery(c, 'enabled'), visible }),
  load: read.loadDescriptionType,
  create: libraries.createDescriptionType,
  update: libraries.updateDescriptionType,
  remove: libraries.deleteDescriptionType,
};

const DIMENSIONS: ObjectRoutes<read.DimensionView, input.DimensionCreate, input.DimensionPatch> = {
  object: 'dimension',
  path: 'dimensions',
  table: 'talent_dimensions',
  createSchema: input.dimensionCreate,
  patchSchema: input.dimensionPatch,
  owner: ownedBy,
  references: (body) => [
    ...('libraryId' in body ? (['library'] as const) : []),
    ...(body.categoryId ? (['dimensionCategory'] as const) : []),
  ],
  list: (tx, tenantId, c, page, visible) =>
    read.listDimensions(tx, tenantId, {
      ...page,
      libraryId: uuidQuery(c, 'libraryId'),
      categoryId: uuidQuery(c, 'categoryId'),
      type: typeQuery(c),
      enabled: booleanQuery(c, 'enabled'),
      name: nameQuery(c),
      visible,
    }),
  load: read.loadDimension,
  create: dimensions.createDimension,
  update: dimensions.updateDimension,
  remove: dimensions.deleteDimension,
};

const CATEGORIES: ObjectRoutes<read.CategoryView, input.CategoryCreate, input.CategoryPatch> = {
  object: 'criterionCategory',
  path: 'criterion-categories',
  table: 'talent_criterion_categories',
  createSchema: input.categoryCreate,
  patchSchema: input.categoryPatch,
  owner: ownedBy,
  references: () => [],
  list: (tx, tenantId, _c, page, visible) => read.listCategories(tx, tenantId, { ...page, visible }),
  load: read.loadCategory,
  create: criteria.createCategory,
  update: criteria.updateCategory,
  remove: criteria.deleteCategory,
};

const CRITERIA: ObjectRoutes<read.CriterionView, input.CriterionCreate, input.CriterionPatch> = {
  object: 'criterion',
  path: 'criteria',
  table: 'talent_criteria',
  createSchema: input.criterionCreate,
  patchSchema: input.criterionPatch,
  owner: ownedBy,
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
  create: criteria.createCriterion,
  update: criteria.updateCriterion,
  remove: criteria.deleteCriterion,
};

export function registerTalentRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerModelImageRoutes(router, deps);
  registerCandidates(router, deps);
  registerObject(router, deps, LIBRARIES);
  registerObject(router, deps, DIMENSION_CATEGORIES);
  registerObject(router, deps, DESCRIPTION_TYPES);
  registerObject(router, deps, DIMENSIONS);
  registerObject(router, deps, CATEGORIES);
  registerObject(router, deps, CRITERIA);
  registerDimensionCategoryBatch(router, deps);
}

/**
 * 「设置指标类别」（DEC-294⑤；e0a68da）：数据操作权（编辑）+ 详情按钮 setDimensionCategory + 标准 dimensions 字段的
 * 编辑权 + 当前范围（行锁后判定），If-Match revision、幂等键与审计同普通编辑。
 */
function registerDimensionCategoryBatch(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post(`${TALENT_BASE}/${CRITERIA.path}/:id/dimension-category`, async (c) => {
    const ctx = await talentWriteContext(c, deps, 'criterion', 'setDimensionCategory', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, input.dimensionCategoryBatch);
    await checkWriteFields(deps, ctx, 'criterion', 'update', { dimensions: body });
    return runTalentWrite(c, deps, ctx, CRITERIA, body, 200, (tx, w) => criteria.setDimensionCategory(tx, w, id, body));
  });
}

function registerObject<View extends Tracked, Create extends object, Patch extends object>(
  router: Hono<TenantEnv>,
  deps: TenantRouteDeps,
  spec: ObjectRoutes<View, Create, Patch>,
) {
  const path = `${TALENT_BASE}/${spec.path}`;
  const present = presenter(deps, spec.object);
  router.get(path, async (c) => {
    const ctx = await talentContext(c, deps, spec.object);
    const page = pageQuery(c);
    const scope = await talentScope(c, deps, ctx, spec.object);
    const visible = visibleSql(scope, scopeColumns(spec.object, spec.table));
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => spec.list(tx, ctx.tenantId, c, page, visible));
    const shown = await present(c, ctx, items);
    return c.json({ ...listEnvelope(page, scope, spec.object), items: shown });
  });
  router.get(`${path}/:id`, async (c) => {
    const ctx = await talentContext(c, deps, spec.object);
    const id = uuidParam(c);
    const scope = await talentScope(c, deps, ctx, spec.object);
    const found = await withTenant(deps.db, ctx.tenantId, (tx) => spec.load(tx, ctx.tenantId, id));
    // 不存在与范围外同一个 404（requireVisible 的文案），不泄露对象是否存在
    if (!found) throw new AppError('NOT_FOUND', `${TALENT_LABELS[spec.object]}不存在`);
    requireVisible(scope, spec.object, spec.owner(found));
    c.header('ETag', `"${found.revision}"`);
    return c.json((await present(c, ctx, [found]))[0]);
  });
  router.post(path, async (c) => {
    const ctx = await talentWriteContext(c, deps, spec.object, 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, spec.createSchema);
    await checkWriteFields(deps, ctx, spec.object, 'create', body as Record<string, unknown>);
    return runTalentWrite(c, deps, ctx, spec, body, 201, (tx, w) => spec.create(tx, w, body));
  });
  router.patch(`${path}/:id`, async (c) => {
    const ctx = await talentWriteContext(c, deps, spec.object, 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, spec.patchSchema);
    await checkWriteFields(deps, ctx, spec.object, 'update', body as Record<string, unknown>);
    return runTalentWrite(c, deps, ctx, spec, body, 200, (tx, w) => spec.update(tx, w, id, body));
  });
  router.delete(`${path}/:id`, async (c) => {
    const ctx = await talentWriteContext(c, deps, spec.object, 'delete', revision(c));
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
  execute: (tx: Tx, ctx: WriteContext) => Promise<View>,
) {
  const scope = await talentScope(c, deps, ctx, spec.object);
  const references: Partial<Record<TalentObject, ModuleScope | null>> = {};
  const referenceFields: ReferenceFields = {};
  for (const object of spec.references(body as Create | Patch)) {
    const access = await referenceAccess(c, deps, ctx, object);
    references[object] = access.scope;
    referenceFields[object] = access.fields;
  }
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input: body },
    execute: async (tx, commandId) => ({
      status,
      body: await execute(tx, { ...ctx, commandId, scope, references, referenceFields }),
    }),
  });
  const view = result.body as View;
  requireVisible(scope, spec.object, spec.owner(view));
  if (c.req.method !== 'DELETE') c.header('ETag', `"${view.revision}"`);
  return c.json((await presenter(deps, spec.object)(c, ctx, [view]))[0], result.status);
}

/** 引用对象的查看权、范围与可见字段（按当前权限，事务外解析；首次执行在事务内逐个复核）。 */
async function referenceAccess(c: Context<TenantEnv>, deps: TenantRouteDeps, ctx: TalentContext, object: TalentObject) {
  const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf(object), fields: [] });
  if (!canView) return { scope: null, fields: new Set<string>() };
  return { scope: await talentScope(c, deps, ctx, object), fields: await viewableFields(deps, ctx, object) };
}

/** 按字段权限裁剪；人才标准里嵌套的指标内容另按指标对象的查看权、范围与字段权限，只投影三项（DEC-281⑪）。 */
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
