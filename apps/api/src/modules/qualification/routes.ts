/**
 * R3-T02 PR-A 任职资格配置接口（docs/02_业务建模/23 §3；设计 §3.1、§5；路由声明见
 * docs/08_设计/R3-T02-A_任职资格配置_路由声明.md）。挂在 /api/tenant/qualification/ 之下：
 * 分类 category-classes、类别 categories（含引入 categories/import）、层级 layers、级别 levels（含引入 levels/import）、
 * 指标类型 target-types、指标 targets（含等级描述 targets/:id/grade-descriptions）、等级方案 grade-schemes、
 * 编码规则 coding-rules、标准 standards（含编辑导入 standards/import、发展通道 standards/:id/channels、图谱 standards/:id/chart）。
 * 写入走命令台账（幂等、revision 409），首次执行与幂等重放都按当前功能权限、按钮与范围复核。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields, scopeAllows } from '../permission/module-access.js';
import { JOB_OBJECT_CODES, requestScope } from '../permission/module-route-access.js';
import type { ScopedJobKind } from '../permission/module-contracts.js';
import { booleanQuery, pageQuery, parseBody, requireNew, revision, uuidParam, uuidQuery } from '../talent/http.js';
import {
  accessSql,
  ANCHOR,
  checkWriteFields,
  codeOf,
  fieldVisible,
  listEnvelope,
  type ModuleScope,
  objectFields,
  qlReadable,
  QUALIFICATION_LABELS,
  qualificationContext,
  type QualificationContext,
  type QualificationObject,
  qualificationScope,
  qualificationWriteContext,
  requireReadable,
  rowsOf,
  trimQualification,
} from './access.js';
import * as config from './config-service.js';
import * as input from './input.js';
import * as read from './read-model.js';
import * as standards from './standard-service.js';
import { rowAccess, type WriteContext } from './store.js';
import * as targets from './target-service.js';

export const QL_BASE = '/api/tenant/qualification';

type View = { readonly id: string; readonly revision: number } & Record<string, unknown>;

interface ObjectRoutes<Create, Patch> {
  readonly object: QualificationObject;
  readonly path: string;
  readonly createSchema: z.ZodType<Create>;
  readonly patchSchema: z.ZodType<Patch>;
  /** 写入时引用的同应用对象（各自按读取范围校验）。 */
  readonly references: readonly QualificationObject[];
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
    filter: (c: Context) => eq('category_id', uuidQuery(c, 'categoryId')),
    decorate: read.withStandardParts,
    create: standards.createStandard,
    update: standards.updateStandard,
    remove: standards.deleteStandard,
  } satisfies ObjectRoutes<input.StandardCreate, input.StandardPatch>,
} as const;

export function registerQualificationRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerImports(router, deps);
  registerTargetExtras(router, deps);
  registerStandardExtras(router, deps);
  for (const spec of Object.values(SPECS)) registerObject(router, deps, spec as ObjectRoutes<object, object>);
}

/** 写命令的上下文：本对象范围、引用对象范围、要读取的字段（指标说明：新格带入，§5.2 #1）、岗职务的读取权限。 */
async function writeContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  object: QualificationObject,
  references: readonly QualificationObject[],
  jobs: readonly ScopedJobKind[] = [],
): Promise<config.ConfigWriteContext> {
  const scopes: Partial<Record<QualificationObject, ModuleScope | null>> = {};
  for (const ref of references) {
    const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf(ref), fields: [] });
    scopes[ref] = canView ? await qualificationScope(c, deps, ctx, ref) : null;
  }
  const jobAccess: Partial<
    Record<ScopedJobKind, { scope: ModuleScope; fields: ReadonlySet<string> | undefined } | null>
  > = {};
  for (const kind of jobs) {
    const code = JOB_OBJECT_CODES[kind];
    const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: code, fields: [] });
    jobAccess[kind] = canView
      ? { scope: await requestScope(c, deps, ctx, code), fields: await getModuleViewableFields(deps, ctx, code) }
      : null;
  }
  return {
    ...ctx,
    scope: await qualificationScope(c, deps, ctx, object),
    scopes,
    fields: references.includes('target') ? { target: await objectFields(deps, ctx, 'target') } : {},
    jobs: jobAccess,
  };
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
    const w = await writeContext(c, deps, ctx, spec.object, spec.references, spec.jobs);
    return runWrite(c, deps, w, spec.object, body, 200, (tx, x) => spec.update(tx, x, id, body));
  });
  router.delete(`${path}/:id`, async (c) => {
    const ctx = await qualificationWriteContext(c, deps, spec.object, 'delete', revision(c));
    const id = uuidParam(c);
    const w = await writeContext(c, deps, ctx, spec.object, []);
    return runWrite(c, deps, w, spec.object, { id }, 200, (tx, x) => spec.remove(tx, x, id));
  });
}

/**
 * 命令执行：范围在事务外按当前权限解析，首次执行在事务内逐个复核（行锁之后）；幂等重放按当前范围复核结果对象
 * （撤权后重放 404，AGENTS §10）。响应按当前字段权限裁剪。
 */
async function runWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  w: WriteContext,
  object: QualificationObject,
  body: object,
  status: 200 | 201,
  execute: (tx: Tx, ctx: WriteContext) => Promise<unknown>,
  shown: QualificationObject | null = object,
) {
  const result = await runCommand(deps.db, w, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: w.expectedRevision, input: body },
    execute: async (tx, commandId) => ({ status, body: await execute(tx, { ...w, commandId }) }),
  });
  const value = result.body as Partial<View>;
  if (shown && typeof value.id === 'string') await requireStillVisible(deps, w, object, value as View, c.req.method);
  if (typeof value.revision === 'number' && c.req.method !== 'DELETE') c.header('ETag', `"${value.revision}"`);
  const payload =
    shown && typeof value.id === 'string' ? (await presenter(deps, shown)(c, w, [value as View]))[0] : value;
  return c.json(payload, result.status);
}

/** 重放时按当前范围复核结果对象：现存对象按读取谓词，已删除对象按快照的锚点（删除要求可写，不看向下公开）。 */
async function requireStillVisible(
  deps: TenantRouteDeps,
  w: WriteContext,
  object: QualificationObject,
  value: View,
  method: string,
) {
  if (method !== 'DELETE') {
    const { access } = await withTenant(deps.db, w.tenantId, (tx) => rowAccess(tx, w, w.scope, object, value.id));
    requireReadable(access, object);
    return;
  }
  const target =
    ANCHOR[object] === 'dictionary'
      ? { creatorId: value.createdBy as string }
      : { orgId: value.ownerOrgId as string, creatorId: value.ownerId as string };
  if (!scopeAllows(w.scope, target)) throw new AppError('NOT_FOUND', `${QUALIFICATION_LABELS[object]}不存在`);
}

/**
 * 按字段权限裁剪；标准里通用指标覆盖写入的能力标准另按查看人当前对 Target.description 的查看权与该指标的读取范围
 * 给出（§5.2 #2）：看不到只留标记 projectionHidden，不给内容。
 */
function presenter(deps: TenantRouteDeps, object: QualificationObject) {
  return async <T extends object>(c: Context<TenantEnv>, ctx: QualificationContext, items: T[]) => {
    if (object !== 'standard') return trimQualification(deps, ctx, object, items);
    const shaped = await hideOverwritten(c, deps, ctx, items as unknown as read.StandardView[]);
    return trimQualification(deps, ctx, object, shaped);
  };
}

async function hideOverwritten(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  items: read.StandardView[],
) {
  const sources = new Set(
    items.flatMap((item) =>
      item.details.flatMap((detail) =>
        detail.abilities.filter((a) => a.source === 'common_overwrite').map((a) => a.sourceTargetId!),
      ),
    ),
  );
  if (!sources.size) return items;
  const fields = await objectFields(deps, ctx, 'target');
  const canView = fieldVisible(fields, 'description') && (fields === undefined || fields.size > 0);
  let readable = new Set<string>();
  if (canView) {
    const scope = await qualificationScope(c, deps, ctx, 'target');
    readable = await withTenant(
      deps.db,
      ctx.tenantId,
      async (tx) =>
        new Set(
          rowsOf<{ id: string }>(
            await tx.execute(sql`SELECT t.id FROM ql_targets t WHERE t.tenant_id = ${ctx.tenantId}::uuid
            AND t.id = ANY(${`{${[...sources].join(',')}}`}::uuid[]) AND ${qlReadable(ctx, scope, 't')}`),
          ).map((row) => row.id),
        ),
    );
  }
  return items.map((item) => ({
    ...item,
    details: item.details.map((detail) => ({
      ...detail,
      abilities: detail.abilities.map(({ sourceTargetId, ...ability }) => {
        if (ability.source !== 'common_overwrite' || readable.has(sourceTargetId!)) return ability;
        const { content: _hidden, ...rest } = ability;
        return { ...rest, projectionHidden: true as const };
      }),
    })),
  }));
}

function registerImports(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 引入任职类别 / 级别（QL-R1 / R2，AC-QL-01）：新建授权 + 按钮；编码、名称、关联字段须有编辑权
  const importRoute = <T extends { items: unknown[] }>(
    object: 'category' | 'level',
    path: string,
    schema: z.ZodType<T>,
    jobs: readonly ScopedJobKind[],
    references: readonly QualificationObject[],
    execute: (tx: Tx, ctx: config.ConfigWriteContext, body: T) => Promise<{ items: read.JobLinked[] }>,
  ) =>
    router.post(`${QL_BASE}/${path}/import`, async (c) => {
      const ctx = await qualificationWriteContext(c, deps, object, 'create', revision(c));
      requireNew(ctx.expectedRevision);
      const body = await parseBody(c, schema);
      const { items: _items, ...fields } = body as Record<string, unknown>;
      await checkWriteFields(deps, ctx, object, 'create', { ...fields, code: null, name: null, jobLinks: [] });
      const w = await writeContext(c, deps, ctx, object, references, jobs);
      const result = await runCommand(deps.db, w, {
        id: c.req.header('idempotency-key'),
        fingerprint: { method: 'POST', path: c.req.path, expectedRevision: 0, input: body },
        execute: async (tx, commandId) => ({ status: 201, body: await execute(tx, { ...w, commandId }, body) }),
      });
      const created = result.body as { items: View[] };
      return c.json({ items: await presenter(deps, object)(c, w, created.items) }, result.status);
    });
  importRoute(
    'category',
    'categories',
    input.categoryImport,
    CATEGORY_JOBS,
    ['categoryClass'],
    config.importCategories,
  );
  importRoute('level', 'levels', input.levelImport, LEVEL_JOBS, ['layer'], config.importLevels);
}

function registerTargetExtras(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 指标等级描述（QL-R7、§5.2 #3）：随指标的读取范围；未手改的描述是等级明细描述的投影，按查看人对等级方案明细的查看权
  router.get(`${QL_BASE}/targets/:id/grade-descriptions`, async (c) => {
    const ctx = await qualificationContext(c, deps, 'target');
    const id = uuidParam(c);
    const scope = await qualificationScope(c, deps, ctx, 'target');
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      requireReadable((await rowAccess(tx, ctx, scope, 'target', id)).access, 'target');
      return targets.gradeDescriptions(tx, ctx.tenantId, id);
    });
    const own = await objectFields(deps, ctx, 'targetGradeDescription');
    const projected = await objectFields(deps, ctx, 'gradeScheme');
    const shown = items.map((item) => {
      const allowed = item.modified ? fieldVisible(own, 'description') : fieldVisible(projected, 'details');
      return allowed ? item : { ...item, description: undefined };
    });
    return c.json({ items: shown });
  });
  router.put(`${QL_BASE}/targets/:id/grade-descriptions/:detailId`, async (c) => {
    const ctx = await qualificationWriteContext(c, deps, 'target', 'update', revision(c));
    const id = uuidParam(c);
    const detailId = uuidParam(c, 'detailId');
    const body = await parseBody(c, input.gradeDescriptionPut);
    await checkWriteFields(deps, ctx, 'targetGradeDescription', 'update', body);
    const w = await writeContext(c, deps, ctx, 'target', []);
    return runWrite(
      c,
      deps,
      w,
      'target',
      body,
      200,
      (tx, x) => targets.putGradeDescription(tx, x, id, detailId, body.description),
      null,
    );
  });

  // 编码规则（QL-R3）：四项，只能编辑
  router.get(`${QL_BASE}/coding-rules`, async (c) => {
    const ctx = await qualificationContext(c, deps, 'codingRule');
    const scope = await qualificationScope(c, deps, ctx, 'codingRule');
    const items = scope.all
      ? await withTenant(deps.db, ctx.tenantId, (tx) => config.listCodingRules(tx, ctx.tenantId))
      : [];
    return c.json({ items: await trimQualification(deps, ctx, 'codingRule', items) });
  });
  router.patch(`${QL_BASE}/coding-rules/:item`, async (c) => {
    const item = c.req.param('item');
    if (!(config.CODING_ITEMS as readonly string[]).includes(item)) throw new AppError('NOT_FOUND', '编码规则不存在');
    const ctx = await qualificationWriteContext(c, deps, 'codingRule', 'update', revision(c));
    const body = await parseBody(c, input.codingRulePatch);
    await checkWriteFields(deps, ctx, 'codingRule', 'update', body);
    const w = await writeContext(c, deps, ctx, 'codingRule', []);
    return runWrite(
      c,
      deps,
      w,
      'codingRule',
      body,
      200,
      (tx, x) => config.updateCodingRule(tx, x, item as config.CodingItem, body),
      null,
    );
  });
}

function registerStandardExtras(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 编辑导入标准明细（QL-R11、AC-QL-05）：标准的编辑授权 + 按钮
  router.post(`${QL_BASE}/standards/import`, async (c) => {
    const ctx = await qualificationWriteContext(c, deps, 'standard', 'update', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, input.standardImport);
    await checkWriteFields(deps, ctx, 'standard', 'update', { details: body.rows });
    const w = await writeContext(c, deps, ctx, 'standard', ['level', 'target']);
    return runWrite(c, deps, w, 'standard', body, 200, (tx, x) => standards.importStandardDetails(tx, x, body), null);
  });

  // 发展通道（QL-R13）：随标准的读取范围与编辑授权
  router.get(`${QL_BASE}/standards/:id/channels`, async (c) => {
    const ctx = await qualificationContext(c, deps, 'developmentChannel');
    const id = uuidParam(c);
    const scope = await qualificationScope(c, deps, ctx, 'standard');
    const view = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      requireReadable((await rowAccess(tx, ctx, scope, 'standard', id)).access, 'standard');
      return standards.loadChannels(tx, ctx.tenantId, id);
    });
    return c.json(view);
  });
  router.put(`${QL_BASE}/standards/:id/channels`, async (c) => {
    const ctx = await qualificationWriteContext(c, deps, 'developmentChannel', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, input.channelsPut);
    await checkWriteFields(deps, ctx, 'developmentChannel', 'update', {
      targetCategoryId: null,
      targetLevelId: null,
      levelId: null,
    });
    const w = await writeContext(c, deps, ctx, 'standard', ['category', 'level']);
    return runWrite(c, deps, w, 'standard', body, 200, (tx, x) => standards.putChannels(tx, x, id, body), null);
  });

  registerChart(router, deps);
}

function registerChart(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 图谱查看（QL-R12）：标准按级别横向拉平；导出在 C1
  router.get(`${QL_BASE}/standards/:id/chart`, async (c) => {
    const ctx = await qualificationContext(c, deps, 'standard');
    const id = uuidParam(c);
    const scope = await qualificationScope(c, deps, ctx, 'standard');
    const standard = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      requireReadable((await rowAccess(tx, ctx, scope, 'standard', id)).access, 'standard');
      const rows = await read.withStandardParts(tx, ctx.tenantId, [
        (await read.loadRow(tx, ctx.tenantId, 'standard', id))!,
      ]);
      const levels = rowsOf<{ id: string; display_order: number }>(
        await tx.execute(sql`SELECT id, display_order FROM ql_levels WHERE tenant_id = ${ctx.tenantId}::uuid
          AND id = ANY(${`{${rows[0]!.levelIds.join(',')}}`}::uuid[]) ORDER BY display_order`),
      );
      return { standard: rows[0]!, levels };
    });
    const [shown] = (await presenter(deps, 'standard')(c, ctx, [standard.standard])) as Partial<read.StandardView>[];
    const details = shown?.details ?? [];
    return c.json({
      standardId: id,
      levels: standard.levels.map((level) => ({
        levelId: level.id,
        displayOrder: level.display_order,
        description: shown?.levelDescriptions?.find((d) => d.levelId === level.id)?.description,
        cells: details.filter((detail) => detail.levelId === level.id),
      })),
    });
  });
}
