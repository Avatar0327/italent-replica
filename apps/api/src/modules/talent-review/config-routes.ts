/**
 * R3-T04 PR-B1 配置对象接口（设计 §7 配置 CRUD 行；前缀 /api/tenant/talent-review）：盘点分类 categories、盘点角色 roles、
 * 盘点字段目录 fields（选项随字段整组维护）与租户设置 settings。路由权限声明见 docs/08_设计/R3-T04_PR-B1_路由声明.md。
 * 写入走命令台账（幂等、If-Match revision 409），首次执行与幂等重放都按当前功能权限、按钮与范围复核，响应按当前字段裁剪。
 * 没有组织字段：列表按创建人谓词（分页之前）过滤，详情 / 写入范围外与不存在同一个 404；新建与设置只有看全部可建。
 */
import { withTenant, type Tx } from '@italent/db';
import type { Context, Hono } from 'hono';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { booleanQuery, pageQuery, parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import {
  checkWriteFields,
  configEnvelope,
  configScopeSql,
  notFoundMessage,
  requireConfigCreatable,
  requireConfigVisible,
  requireFilterVisible,
  reviewContext,
  reviewScope,
  reviewWriteContext,
  TALENT_REVIEW_BASE,
  trimReview,
  type ModuleScope,
  type TalentReviewContext,
} from './access.js';
import {
  categoryCreate,
  categoryPatch,
  fieldCreate,
  fieldPatch,
  roleCreate,
  rolePatch,
  settingsPatch,
} from './config-input.js';
import {
  createConfig,
  deleteConfig,
  listConfig,
  loadConfig,
  updateConfig,
  type ConfigObject,
  type ConfigSpec,
  type WriteContext,
} from './config-kit.js';
import * as simple from './config-service.js';
import * as fields from './field-service.js';
import * as settings from './settings-service.js';

const CATEGORIES = `${TALENT_REVIEW_BASE}/categories`;
const ROLES = `${TALENT_REVIEW_BASE}/roles`;
const FIELDS = `${TALENT_REVIEW_BASE}/fields`;
const SETTINGS = `${TALENT_REVIEW_BASE}/settings`;

type Viewed = { createdBy: string | null; revision: number };

/** 列表公共部分：分页、enabled 筛选（筛选字段须有查看权）、范围谓词；返回信封与已裁剪的条目。 */
async function listResponse<V extends { id: string; name: string }>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  object: ConfigObject,
  table: string,
  spec: ConfigSpec<V>,
  assemble?: (tx: Tx, rows: unknown[]) => Promise<unknown[]>,
) {
  const page = pageQuery(c);
  const enabled = booleanQuery(c, 'enabled');
  // 筛选字段同样受字段查看权约束：看不到 enabled 的人不能用筛选还原启用状态
  if (enabled !== undefined) await requireFilterVisible(deps, ctx, object, 'enabled');
  const scope = await reviewScope(c, deps, ctx, object);
  const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    const rows = await listConfig(tx, spec, ctx.tenantId, { ...page, enabled, visible: configScopeSql(scope, table) });
    return assemble ? assemble(tx, rows) : rows;
  });
  return c.json({ ...configEnvelope(page, scope), items: await trimReview(deps, ctx, object, items as object[]) });
}

async function detailResponse<V extends Viewed & { id: string; name: string }>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  object: ConfigObject,
  spec: ConfigSpec<V>,
) {
  const id = uuidParam(c);
  const scope = await reviewScope(c, deps, ctx, object);
  const found = await withTenant(deps.db, ctx.tenantId, (tx) => loadConfig(tx, spec, ctx.tenantId, id));
  // 不存在与范围外同一个 404，不泄露对象是否存在
  if (!found) throw new AppError('NOT_FOUND', notFoundMessage(object));
  requireConfigVisible(scope, object, found.createdBy);
  c.header('ETag', `"${found.revision}"`);
  return c.json((await trimReview(deps, ctx, object, [found]))[0]);
}

/**
 * 命令执行：范围在事务外按当前权限解析，首次执行在事务内行锁后复核；幂等重放按当前范围复核结果对象
 * （撤范围后重放 404，AGENTS §10），响应按当前字段权限裁剪。
 */
async function runWrite<V extends Viewed>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  object: ConfigObject | 'settings',
  body: object,
  status: 200 | 201,
  recheck: (scope: ModuleScope, view: V) => void,
  execute: (tx: Tx, ctx: WriteContext) => Promise<V>,
) {
  const scope = await reviewScope(c, deps, ctx, object);
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input: body },
    execute: async (tx, commandId) => ({ status, body: await execute(tx, { ...ctx, commandId, scope }) }),
  });
  const view = result.body as V;
  recheck(scope, view);
  if (c.req.method !== 'DELETE') c.header('ETag', `"${view.revision}"`);
  return c.json((await trimReview(deps, ctx, object, [view]))[0], result.status);
}
const visibleTo = (object: ConfigObject) => (scope: ModuleScope, view: Viewed) =>
  requireConfigVisible(scope, object, view.createdBy);

export function registerConfigRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerSettings(router, deps);
  registerCategories(router, deps);
  registerRoles(router, deps);
  registerFields(router, deps);
}

function registerSettings(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(SETTINGS, async (c) => {
    const ctx = await reviewContext(c, deps, 'settings');
    const scope = await reviewScope(c, deps, ctx, 'settings');
    requireConfigCreatable(scope, 'settings');
    const view = await withTenant(deps.db, ctx.tenantId, (tx) => settings.loadSettings(tx, ctx.tenantId));
    c.header('ETag', `"${view.revision}"`);
    return c.json((await trimReview(deps, ctx, 'settings', [view]))[0]);
  });
  router.patch(SETTINGS, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'settings', 'update', revision(c));
    const body = await parseBody(c, settingsPatch);
    await checkWriteFields(deps, ctx, 'settings', 'update', body);
    return runWrite(
      c,
      deps,
      ctx,
      'settings',
      body,
      200,
      (scope) => requireConfigCreatable(scope, 'settings'),
      (tx, w) => settings.updateSettings(tx, w, body),
    );
  });
}

function registerCategories(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(CATEGORIES, async (c) => {
    const ctx = await reviewContext(c, deps, 'category');
    return listResponse(c, deps, ctx, 'category', 'talent_review_categories', simple.CATEGORY);
  });
  router.get(`${CATEGORIES}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'category');
    return detailResponse(c, deps, ctx, 'category', simple.CATEGORY);
  });
  router.post(CATEGORIES, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'category', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, categoryCreate);
    await checkWriteFields(deps, ctx, 'category', 'create', body);
    return runWrite(c, deps, ctx, 'category', body, 201, visibleTo('category'), (tx, w) =>
      createConfig(tx, simple.CATEGORY, w, body),
    );
  });
  router.patch(`${CATEGORIES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'category', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, categoryPatch);
    await checkWriteFields(deps, ctx, 'category', 'update', body);
    return runWrite(c, deps, ctx, 'category', body, 200, visibleTo('category'), (tx, w) =>
      updateConfig(tx, simple.CATEGORY, w, id, body),
    );
  });
  router.delete(`${CATEGORIES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'category', 'delete', revision(c));
    const id = uuidParam(c);
    return runWrite(c, deps, ctx, 'category', { id }, 200, visibleTo('category'), (tx, w) =>
      deleteConfig(tx, simple.CATEGORY, w, id),
    );
  });
}

function registerRoles(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(ROLES, async (c) => {
    const ctx = await reviewContext(c, deps, 'role');
    return listResponse(c, deps, ctx, 'role', 'talent_review_roles', simple.ROLE);
  });
  router.get(`${ROLES}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'role');
    return detailResponse(c, deps, ctx, 'role', simple.ROLE);
  });
  router.post(ROLES, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'role', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, roleCreate);
    await checkWriteFields(deps, ctx, 'role', 'create', body);
    return runWrite(c, deps, ctx, 'role', body, 201, visibleTo('role'), (tx, w) =>
      createConfig(tx, simple.ROLE, w, body),
    );
  });
  router.patch(`${ROLES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'role', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, rolePatch);
    await checkWriteFields(deps, ctx, 'role', 'update', body);
    return runWrite(c, deps, ctx, 'role', body, 200, visibleTo('role'), (tx, w) =>
      updateConfig(tx, simple.ROLE, w, id, body),
    );
  });
  router.delete(`${ROLES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'role', 'delete', revision(c));
    const id = uuidParam(c);
    return runWrite(c, deps, ctx, 'role', { id }, 200, visibleTo('role'), (tx, w) =>
      deleteConfig(tx, simple.ROLE, w, id),
    );
  });
}

function registerFields(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(FIELDS, async (c) => {
    const ctx = await reviewContext(c, deps, 'field');
    return listResponse(c, deps, ctx, 'field', 'talent_review_fields', fields.FIELD, (tx, rows) =>
      fields.withOptions(tx, ctx.tenantId, rows as never),
    );
  });
  router.get(`${FIELDS}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'field');
    return detailResponse(c, deps, ctx, 'field', fields.FIELD);
  });
  router.post(FIELDS, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'field', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, fieldCreate);
    await checkWriteFields(deps, ctx, 'field', 'create', body);
    return runWrite(c, deps, ctx, 'field', body, 201, visibleTo('field'), (tx, w) => fields.createField(tx, w, body));
  });
  router.patch(`${FIELDS}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'field', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, fieldPatch);
    await checkWriteFields(deps, ctx, 'field', 'update', body);
    return runWrite(c, deps, ctx, 'field', body, 200, visibleTo('field'), (tx, w) =>
      fields.updateField(tx, w, id, body),
    );
  });
  router.delete(`${FIELDS}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'field', 'delete', revision(c));
    const id = uuidParam(c);
    return runWrite(c, deps, ctx, 'field', { id }, 200, visibleTo('field'), (tx, w) => fields.deleteField(tx, w, id));
  });
}
