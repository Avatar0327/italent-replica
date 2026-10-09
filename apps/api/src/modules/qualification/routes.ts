/**
 * R3-T02 PR-A 任职资格配置接口（docs/02_业务建模/23 §3；设计 §3.1、§5；路由声明见
 * docs/08_设计/R3-T02-A_任职资格配置_路由声明.md）。挂在 /api/tenant/qualification/ 之下：
 * 分类 category-classes、类别 categories、层级 layers、级别 levels、指标类型 target-types、指标 targets、
 * 等级方案 grade-schemes、标准 standards 的增删改查在本文件；引入、指标等级描述、编码规则、标准明细导入、发展通道、
 * 图谱在 extras.ts；新建时的所属管理单元候选 candidates/owner-orgs 在 candidates.ts（DEC-339）。
 * 写入走命令台账（幂等、revision 409），首次执行与幂等重放都按当前功能权限、按钮与范围复核。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import type { ScopedJobKind } from '../permission/module-contracts.js';
import { booleanQuery, pageQuery, parseBody, requireNew, revision, uuidParam, uuidQuery } from '../talent/http.js';
import {
  accessSql,
  ANCHOR,
  checkWriteFields,
  codeOf,
  listEnvelope,
  qualificationContext,
  type QualificationContext,
  type QualificationObject,
  qualificationScope,
  qualificationWriteContext,
  requireReadable,
} from './access.js';
import { registerQualificationCandidates } from './candidates.js';
import * as config from './config-service.js';
import { registerExtras } from './extras.js';
import './subset-policy.js'; // 登记 qualification 子集策略（C1-1）
import * as input from './input.js';
import * as read from './read-model.js';
import { fieldEditable, presenter, QL_BASE, runWrite, type View, writeContext } from './route-support.js';
import * as standards from './standard-service.js';
import { rowAccess, type WriteContext } from './store.js';
import * as targets from './target-service.js';

export { QL_BASE };

interface ObjectRoutes<Create, Patch> {
  readonly object: QualificationObject;
  readonly path: string;
  readonly createSchema: z.ZodType<Create>;
  readonly patchSchema: z.ZodType<Patch>;
  /** 写入时引用的同应用对象（各自按读取范围校验）。 */
  readonly references: readonly QualificationObject[];
  /** 删除时连带删除的子对象（另需删除权并逐条写删除快照，store.deleteChildren）。 */
  readonly children?: readonly QualificationObject[];
  /** 删除时还要按写范围校验的对象（等级方案连带的遗留描述按所属指标，第 3 轮 R2-06）。 */
  readonly deleteScopes?: readonly QualificationObject[];
  /** 写入要读取的岗职务对象（引入 / 关联）。 */
  readonly jobs?: readonly ScopedJobKind[];
  readonly filter?: (c: Context) => SQL;
  readonly decorate?: (tx: Tx, tenantId: string, rows: Record<string, unknown>[]) => Promise<unknown[]>;
  create(tx: Tx, ctx: WriteContext, body: Create): Promise<unknown>;
  update(tx: Tx, ctx: WriteContext, id: string, body: Patch): Promise<unknown>;
  remove(tx: Tx, ctx: WriteContext, id: string): Promise<unknown>;
}

const eq = (column: string, value: string | boolean | undefined) =>
  value === undefined ? sql`true` : sql`${sql.identifier('t')}.${sql.identifier(column)} = ${value}`;

const CATEGORY_JOBS: readonly ScopedJobKind[] = ['positions', 'posts', 'sequences', 'level-types'];
const LEVEL_JOBS: readonly ScopedJobKind[] = ['levels', 'grades'];

const SPECS = {
  categoryClass: {
    object: 'categoryClass',
    path: 'category-classes',
    createSchema: input.categoryClassCreate,
    patchSchema: input.categoryClassPatch,
    references: ['categoryClass'],
    filter: (c: Context) => eq('enabled', booleanQuery(c, 'enabled')),
    create: config.createCategoryClass,
    update: config.updateCategoryClass,
    remove: config.deleteCategoryClass,
  } satisfies ObjectRoutes<input.CategoryClassCreate, input.CategoryClassPatch>,
  category: {
    object: 'category',
    path: 'categories',
    createSchema: input.categoryCreate,
    patchSchema: input.categoryPatch,
    references: ['categoryClass'],
    jobs: CATEGORY_JOBS,
    filter: (c: Context) =>
      sql`${eq('class_id', uuidQuery(c, 'classId'))} AND ${eq('enabled', booleanQuery(c, 'enabled'))}`,
    decorate: (tx: Tx, tenantId: string, rows: Record<string, unknown>[]) =>
      read.withJobLinks(tx, tenantId, 'category', rows),
    create: config.createCategory,
    update: config.updateCategory,
    remove: config.deleteCategory,
  } satisfies ObjectRoutes<input.CategoryCreate, input.CategoryPatch>,
  layer: {
    object: 'layer',
    path: 'layers',
    createSchema: input.layerCreate,
    patchSchema: input.layerPatch,
    references: [],
    create: config.createLayer,
    update: config.updateLayer,
    remove: config.deleteLayer,
  } satisfies ObjectRoutes<input.LayerCreate, input.LayerPatch>,
  level: {
    object: 'level',
    path: 'levels',
    createSchema: input.levelCreate,
    patchSchema: input.levelPatch,
    references: ['layer'],
    jobs: LEVEL_JOBS,
    filter: (c: Context) => eq('enabled', booleanQuery(c, 'enabled')),
    decorate: (tx: Tx, tenantId: string, rows: Record<string, unknown>[]) =>
      read.withJobLinks(tx, tenantId, 'level', rows),
    create: config.createLevel,
    update: config.updateLevel,
    remove: config.deleteLevel,
  } satisfies ObjectRoutes<input.LevelCreate, input.LevelPatch>,
  targetType: {
    object: 'targetType',
    path: 'target-types',
    createSchema: input.targetTypeCreate,
    patchSchema: input.targetTypePatch,
    references: ['targetType'],
    filter: (c: Context) => eq('parent_id', uuidQuery(c, 'parentId')),
    create: config.createTargetType,
    update: config.updateTargetType,
    remove: config.deleteTargetType,
  } satisfies ObjectRoutes<input.TargetTypeCreate, input.TargetTypePatch>,
  target: {
    object: 'target',
    path: 'targets',
    createSchema: input.targetCreate,
    patchSchema: input.targetPatch,
    references: ['targetType', 'gradeScheme'],
    children: ['targetGradeDescription'],
    filter: (c: Context) =>
      sql`${eq('type_id', uuidQuery(c, 'typeId'))} AND ${eq('enabled', booleanQuery(c, 'enabled'))}`,
    create: targets.createTarget,
    update: targets.updateTarget,
    remove: targets.deleteTarget,
  } satisfies ObjectRoutes<input.TargetCreate, input.TargetPatch>,
  gradeScheme: {
    object: 'gradeScheme',
    path: 'grade-schemes',
    createSchema: input.gradeSchemeCreate,
    patchSchema: input.gradeSchemePatch,
    references: [],
    children: ['targetGradeDescription'],
    deleteScopes: ['target'],
    decorate: read.withGradeDetails,
    create: targets.createGradeScheme,
    update: targets.updateGradeScheme,
    remove: targets.deleteGradeScheme,
  } satisfies ObjectRoutes<input.GradeSchemeCreate, input.GradeSchemePatch>,
  standard: {
    object: 'standard',
    path: 'standards',
    createSchema: input.standardCreate,
    patchSchema: input.standardPatch,
    references: ['category', 'level', 'target'],
    children: ['developmentChannel'],
    filter: (c: Context) => eq('category_id', uuidQuery(c, 'categoryId')),
    decorate: read.withStandardParts,
    create: standards.createStandard,
    update: standards.updateStandard,
    remove: standards.deleteStandard,
  } satisfies ObjectRoutes<input.StandardCreate, input.StandardPatch>,
} as const;

export function registerQualificationRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerQualificationCandidates(router, deps);
  registerExtras(router, deps);
  for (const spec of Object.values(SPECS)) registerObject(router, deps, spec as ObjectRoutes<object, object>);
}

function registerObject<Create extends object, Patch extends object>(
  router: Hono<TenantEnv>,
  deps: TenantRouteDeps,
  spec: ObjectRoutes<Create, Patch>,
) {
  const path = `${QL_BASE}/${spec.path}`;
  const present = presenter(deps, spec.object);
  const decorate = async (tx: Tx, tenantId: string, rows: Record<string, unknown>[]) =>
    (spec.decorate ? await spec.decorate(tx, tenantId, rows) : rows.map((row) => read.view(row))) as View[];
  router.get(path, async (c) => {
    const ctx = await qualificationContext(c, deps, spec.object);
    const page = pageQuery(c);
    const scope = await qualificationScope(c, deps, ctx, spec.object);
    const { readable } = accessSql(ctx, scope, ANCHOR[spec.object]);
    const filter = spec.filter?.(c) ?? sql`true`;
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) =>
      decorate(tx, ctx.tenantId, await read.listRows(tx, ctx.tenantId, spec.object, readable, page, filter)),
    );
    return c.json({ ...listEnvelope(page, scope, ANCHOR[spec.object]), items: await present(c, ctx, items) });
  });
  router.get(`${path}/:id`, async (c) => {
    const ctx = await qualificationContext(c, deps, spec.object);
    const id = uuidParam(c);
    const scope = await qualificationScope(c, deps, ctx, spec.object);
    const found = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      requireReadable((await rowAccess(tx, ctx, scope, spec.object, id)).access, spec.object);
      return (await decorate(tx, ctx.tenantId, [(await read.loadRow(tx, ctx.tenantId, spec.object, id))!]))[0]!;
    });
    c.header('ETag', `"${found.revision}"`);
    return c.json((await present(c, ctx, [found]))[0]);
  });
  router.post(path, async (c) => {
    const ctx = await qualificationWriteContext(c, deps, spec.object, 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, spec.createSchema);
    await checkWriteFields(deps, ctx, spec.object, 'create', body as Record<string, unknown>);
    const w = await writeContext(c, deps, ctx, spec.object, spec.references, spec.jobs);
    return runWrite(c, deps, w, spec.object, body, 201, (tx, x) => spec.create(tx, x, body));
  });
  router.patch(`${path}/:id`, async (c) => {
    const ctx = await qualificationWriteContext(c, deps, spec.object, 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, spec.patchSchema);
    await checkWriteFields(deps, ctx, spec.object, 'update', body as Record<string, unknown>);
    const w: config.ConfigWriteContext = {
      ...(await writeContext(c, deps, ctx, spec.object, spec.references, spec.jobs)),
      // 改关联类型会派生出清空关联：命令内按这项权限拦截（第 2 轮 P2-04）
      ...(spec.jobs ? { jobLinksEditable: await fieldEditable(deps, ctx, spec.object, 'jobLinks') } : {}),
    };
    return runWrite(c, deps, w, spec.object, body, 200, (tx, x) => spec.update(tx, x, id, body));
  });
  router.delete(`${path}/:id`, async (c) => {
    const ctx = await qualificationWriteContext(c, deps, spec.object, 'delete', revision(c));
    const id = uuidParam(c);
    const w = {
      ...(await writeContext(c, deps, ctx, spec.object, spec.deleteScopes ?? [])),
      childDeletes: await childDeleteRights(deps, ctx, spec),
    };
    return runWrite(c, deps, w, spec.object, { id }, 200, (tx, x) => spec.remove(tx, x, id));
  });
}

/** 子对象的删除数据操作权按当前授权解析；命令内只在确有子对象时才要求（首次与重放都经过这里）。 */
async function childDeleteRights(
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  spec: { children?: readonly QualificationObject[] },
) {
  const result: Partial<Record<QualificationObject, boolean>> = {};
  for (const child of spec.children ?? []) {
    result[child] = await deps.authorize({ ...ctx, action: 'object.delete', resource: codeOf(child), fields: [] });
  }
  return result;
}
