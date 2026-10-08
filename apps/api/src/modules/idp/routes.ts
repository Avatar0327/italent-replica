/**
 * R3-T07 个人发展计划 IDP · 配置接口（docs/02_业务建模/28 §2.1、§2.2；REQ-IDP-001；PR 描述矩阵 A）。挂在 /api/tenant/idp/ 下：
 * 发展计划流程 processes（含子流程）、子流程候选审批流程 approval-processes、发展计划模板 templates（复制 / 发布 /
 * 取消发布）、模板模块 templates/:id/modules（含按流程节点的可用按钮）、模板通用目标 templates/:id/common-goals。
 * 写入走命令台账（幂等、revision 409）；首次执行与幂等重放都按当前功能权限、按钮与范围复核，响应逐层按字段权限裁剪。
 */
import { IDP_APPROVAL_TYPES, type IdpObject, RULE_TEXT_SOURCES } from '@italent/domain';
import { and, eq, idpProcesses, idpTemplates, isUuid, sql, type Tx, withTenant } from '@italent/db';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery, parseBody, requireNew, revision, uuidParam } from '../job/context.js';
import {
  type Anchor,
  checkWriteFields,
  codeOf,
  idpContext,
  type IdpContext,
  idpScope,
  idpWriteContext,
  listEnvelope,
  type ModuleScope,
  project,
  projectionOf,
  type PermissionCheck,
  readableSql,
  replayChecks,
  requireEditable,
  requireReadable,
  rowsOf,
} from './access.js';
import * as input from './input.js';
import { registerKeyInfoRoutes } from './key-info-routes.js';
import { registerPlanRoutes } from './plan-routes.js';
import * as processes from './process-service.js';
import * as read from './read-model.js';
import * as templates from './template-service.js';
import type { WriteContext } from './write-support.js';

const BASE = '/api/tenant/idp';

export function registerIdpRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerProcessRoutes(router, deps);
  registerProcessWrites(router, deps);
  registerCandidateRoutes(router, deps);
  registerTemplateRoutes(router, deps);
  registerTemplateWrites(router, deps);
  registerTemplateActions(router, deps);
  registerTemplatePartRoutes(router, deps);
  // PR-B：计划执行、干预与关键信息
  registerPlanRoutes(router, deps);
  registerKeyInfoRoutes(router, deps);
}

// ---- 响应裁剪 ----

/**
 * 子流程按字段权限裁剪；开启规则说明文本是派生值，与 fixedDate 同一门禁（DEC-309④）：看得到它依据的全部字段才输出。
 */
function subProcessShown(item: read.SubProcessView, sub: ReadonlySet<string> | undefined) {
  const { ruleText, ...fields } = item;
  const shown: Record<string, unknown> = project(fields, sub);
  if (sub === undefined || RULE_TEXT_SOURCES.every((field) => sub.has(field))) shown.ruleText = ruleText;
  return shown;
}

/** 流程：顶层按 IDPProcess、子流程按 SubProcess 字段权限；没有子流程查看权时省略整段。 */
async function processPresenter(deps: TenantRouteDeps, ctx: IdpContext) {
  const top = await projectionOf(deps, ctx, 'process');
  const sub = await projectionOf(deps, ctx, 'subProcess');
  return (view: read.ProcessView) => {
    const { subProcesses, ...rest } = view;
    const shown: Record<string, unknown> = project(rest, top);
    if (sub !== null && (top === undefined || top?.has('subProcesses'))) {
      shown.subProcesses = subProcesses.map((item) => subProcessShown(item, sub));
    }
    return shown;
  };
}

/** 模板：顶层按 IDPTemplate，模块（含节点按钮配置）按 IDPTemplateModule，通用目标按 IDPTemplateCommonGoal。 */
async function templatePresenter(deps: TenantRouteDeps, ctx: IdpContext) {
  const top = await projectionOf(deps, ctx, 'template');
  const modules = await projectionOf(deps, ctx, 'templateModule');
  const goals = await projectionOf(deps, ctx, 'commonGoal');
  const nested = (field: string, projection: typeof modules) =>
    projection !== null && (top === undefined || top?.has(field) === true);
  return (view: read.TemplateSummary | read.TemplateView) => {
    const { modules: moduleList, commonGoals, ...rest } = view as Partial<read.TemplateView> & read.TemplateSummary;
    const shown: Record<string, unknown> = project(rest, top);
    if (moduleList && nested('modules', modules)) shown.modules = moduleList.map((m) => project(m, modules));
    if (commonGoals && nested('commonGoals', goals)) shown.commonGoals = commonGoals.map((g) => project(g, goals));
    return shown;
  };
}

// ---- 命令执行 ----

interface WriteSpec<T> {
  /** 范围锚定的对象（流程或模板；模块与通用目标随模板）。 */
  readonly anchorObject: 'process' | 'template';
  readonly status: 200 | 201;
  readonly body: unknown;
  execute(tx: Tx, ctx: WriteContext): Promise<T>;
  /**
   * 返回前（首次执行与幂等重放都走）按**当前**归属复核**当前可写性**及相关引用（第 2 轮 P2-1）：写入后仍存在的对象按其
   * 当前行判定；删除命令没有当前行，按删除时的受控快照（台账里的结果）判定可写性。范围外 404，仅向下公开可见 403。
   */
  recheck(tx: Tx, scope: ModuleScope, result: T): Promise<void>;
  present(result: T): Promise<unknown>;
}

/** 命令台账里存的结果：业务视图 + 本命令实际用到的权限（重放时复核，P2-2 / P2-3）。 */
interface Stored<T> {
  readonly view: T;
  readonly checks: PermissionCheck[];
}

/**
 * 范围在事务外按当前权限解析，首次执行在事务内（行锁之后）复核；无论首次还是重放，返回前都按对象当前归属复核可写性、
 * 复核命令实际用到的嵌套写权限与查看权（AGENTS §10），响应按当前字段权限裁剪。
 */
async function runIdpWrite<T extends { revision?: number }>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: IdpContext,
  spec: WriteSpec<T>,
) {
  const scope = await idpScope(c, deps, ctx, spec.anchorObject);
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input: spec.body },
    execute: async (tx, commandId) => {
      const checks: PermissionCheck[] = [];
      const view = await spec.execute(tx, { ...ctx, commandId, scope, checks });
      return { status: spec.status, body: { view, checks } satisfies Stored<T> };
    },
  });
  const { view, checks } = result.body as Stored<T>;
  // 先复核命令实际用到的权限（只看权限、不看数据），再按当前数据复核归属与引用：否则重放时引用对象的状态差别
  // （如隐藏的流程停用 / 移走）会先于查看权门禁暴露出来（第 4 轮）
  await replayChecks(deps, ctx, checks);
  await withTenant(deps.db, ctx.tenantId, (tx) => spec.recheck(tx, scope, view));
  if (c.req.method !== 'DELETE' && view.revision !== undefined) c.header('ETag', `"${view.revision}"`);
  return c.json((await spec.present(view)) as object, result.status);
}

/** 流程 / 模板的当前范围锚点（不存在为 undefined）。 */
async function currentAnchor(tx: Tx, tenantId: string, object: 'process' | 'template', id: string) {
  const table = object === 'process' ? idpProcesses : idpTemplates;
  const [row] = await tx
    .select({ orgId: table.orgId, publicDown: table.publicDown, createdBy: table.createdBy })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), eq(table.id, id)));
  return row;
}

/** 写入后的对象按当前行复核可写性（已不存在 → 404）。 */
async function currentEditable(
  tx: Tx,
  ctx: IdpContext,
  scope: ModuleScope,
  object: 'process' | 'template',
  id: string,
) {
  const anchor = await currentAnchor(tx, ctx.tenantId, object, id);
  if (!anchor) throw new AppError('NOT_FOUND', '对象不存在');
  await requireEditable(tx, ctx, scope, object, anchor);
}

/** 相关引用（模板引用的流程、复制的源模板）按当前行复核可见性（已不存在 → 404）。 */
async function currentReadable(
  tx: Tx,
  ctx: IdpContext,
  scope: ModuleScope,
  object: 'process' | 'template',
  id: string,
) {
  const anchor = await currentAnchor(tx, ctx.tenantId, object, id);
  if (!anchor) throw new AppError('NOT_FOUND', '对象不存在');
  await requireReadable(tx, ctx, scope, object, anchor);
}

const anchorOf = (view: { orgId: string; publicDown: boolean; createdBy: string }): Anchor => ({
  orgId: view.orgId,
  publicDown: view.publicDown,
  createdBy: view.createdBy,
});

function booleanQuery(c: Context, name: string): boolean | undefined {
  const value = c.req.query(name);
  if (value === undefined || value === '') return undefined;
  if (value !== 'true' && value !== 'false') throw new AppError('VALIDATION_FAILED', `${name} 必须为 true 或 false`);
  return value === 'true';
}

function uuidQuery(c: Context, name: string): string | undefined {
  const value = c.req.query(name);
  if (value === undefined || value === '') return undefined;
  if (!isUuid(value)) throw new AppError('VALIDATION_FAILED', `${name} 必须为 UUID`);
  return value.toLowerCase();
}

function enumQuery<T extends string>(c: Context, name: string, values: readonly T[]): T | undefined {
  const value = c.req.query(name);
  if (value === undefined || value === '') return undefined;
  if (!(values as readonly string[]).includes(value)) throw new AppError('VALIDATION_FAILED', `${name} 不合法`);
  return value as T;
}

/** 写入口：数据操作权 + 按钮（在命令台账之前，重放同样复核）。 */
const writeContext = (
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  object: IdpObject,
  operation: 'create' | 'update' | 'delete',
  buttonCode: string,
) => idpWriteContext(c, deps, object, operation, buttonCode, buttonCode === 'create' ? 'list' : 'detail', revision(c));

/** 模板引用流程时，流程对象另须查看权（DEC-178 同口径：被引用对象独立判定）。 */
async function processScopeFor(c: Context<TenantEnv>, deps: TenantRouteDeps, ctx: IdpContext): Promise<ModuleScope> {
  const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf('process'), fields: [] });
  if (!canView) throw new AppError('FORBIDDEN', '无权查看发展计划流程');
  return idpScope(c, deps, ctx, 'process');
}

// ---- 流程 ----

function registerProcessRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const path = `${BASE}/processes`;
  router.get(path, async (c) => {
    const ctx = await idpContext(c, deps, 'process');
    const page = pageQuery(c);
    const scope = await idpScope(c, deps, ctx, 'process');
    const visible = readableSql(ctx, scope, {
      org: sql`org_id`,
      publicDown: sql`public_down`,
      creator: sql`created_by`,
    });
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      read.listProcesses(tx, ctx.tenantId, { ...page, enabled: booleanQuery(c, 'enabled'), visible }),
    );
    const present = await processPresenter(deps, ctx);
    return c.json({ ...listEnvelope(page, scope), items: items.map(present) });
  });

  router.get(`${path}/:id`, async (c) => {
    const ctx = await idpContext(c, deps, 'process');
    const id = uuidParam(c);
    const scope = await idpScope(c, deps, ctx, 'process');
    const found = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const view = await read.loadProcess(tx, ctx.tenantId, id);
      if (!view) throw new AppError('NOT_FOUND', '发展计划流程不存在');
      await requireReadable(tx, ctx, scope, 'process', anchorOf(view));
      return view;
    });
    c.header('ETag', `"${found.revision}"`);
    return c.json((await processPresenter(deps, ctx))(found));
  });
}

function registerProcessWrites(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const path = `${BASE}/processes`;
  router.post(path, async (c) => {
    const ctx = await writeContext(c, deps, 'process', 'create', 'create');
    requireNew(ctx);
    const body = await parseBody(c, input.processCreate);
    await checkWriteFields(deps, ctx, 'process', 'create', body);
    return runIdpWrite<read.ProcessView>(c, deps, ctx, {
      anchorObject: 'process',
      status: 201,
      body,
      execute: (tx, w) => processes.createProcess(tx, deps, w, body),
      recheck: (tx, scope, view) => currentEditable(tx, ctx, scope, 'process', view.id),
      present: async (view) => (await processPresenter(deps, ctx))(view),
    });
  });

  router.patch(`${path}/:id`, async (c) => {
    const ctx = await writeContext(c, deps, 'process', 'update', 'update');
    const id = uuidParam(c);
    const body = await parseBody(c, input.processPatch);
    // 子流程按实际变化在事务内逐段校验并记入台账、重放时复核（process-service.ts），这里只校验顶层字段
    const { subProcesses: _subProcesses, ...top } = body;
    await checkWriteFields(deps, ctx, 'process', 'update', top);
    return runIdpWrite<read.ProcessView>(c, deps, ctx, {
      anchorObject: 'process',
      status: 200,
      body,
      execute: (tx, w) => processes.updateProcess(tx, deps, w, id, body),
      recheck: (tx, scope, view) => currentEditable(tx, ctx, scope, 'process', view.id),
      present: async (view) => (await processPresenter(deps, ctx))(view),
    });
  });

  router.delete(`${path}/:id`, async (c) => {
    const ctx = await writeContext(c, deps, 'process', 'delete', 'delete');
    const id = uuidParam(c);
    return runIdpWrite<read.ProcessView>(c, deps, ctx, {
      anchorObject: 'process',
      status: 200,
      body: { id },
      execute: (tx, w) => processes.deleteProcess(tx, deps, w, id),
      // 删除的受控快照：按删除时的归属判定当前可写性
      recheck: (tx, scope, view) => requireEditable(tx, ctx, scope, 'process', anchorOf(view)),
      present: async (view) => (await processPresenter(deps, ctx))(view),
    });
  });
}

function registerCandidateRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  /**
   * 子流程候选审批流程（IDP-R1）：已发布、未废弃的 IDP 三类审批流程及其已发布版本的节点。需要流程的新增或修改权
   * （配置子流程才用得到）；候选是审批中心流程，不带组织，不按 IDP 范围裁剪。
   */
  router.get(`${BASE}/approval-processes`, async (c) => {
    const ctx = await idpContext(c, deps, 'process');
    const can = async (action: string) => deps.authorize({ ...ctx, action, resource: codeOf('process'), fields: [] });
    if (!(await can('object.create')) && !(await can('object.update'))) {
      throw new AppError('FORBIDDEN', '无权配置发展计划流程');
    }
    const type = enumQuery(c, 'approvalType', IDP_APPROVAL_TYPES);
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => approvalCandidates(tx, ctx.tenantId, type, page));
    return c.json({ page: page.page, pageSize: page.pageSize, items });
  });
}

async function approvalCandidates(
  tx: Tx,
  tenantId: string,
  type: string | undefined,
  page: { limit: number; offset: number },
) {
  const types = type ? [type] : [...IDP_APPROVAL_TYPES];
  const processesRows = rowsOf<{ id: string; code: string; approval_type: string; name: string; version_id: string }>(
    await tx.execute(sql`SELECT p.id, p.code, p.approval_type, v.name, v.id AS version_id
      FROM approval_processes p JOIN approval_process_versions v ON v.tenant_id = p.tenant_id
        AND v.id = p.current_version_id
      WHERE p.tenant_id = ${tenantId} AND p.status = 'active'
        AND p.approval_type = ANY(${`{${types.join(',')}}`}::text[])
      ORDER BY p.code, p.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  if (!processesRows.length) return [];
  const nodes = rowsOf<{ version_id: string; node_key: string; name: string; seq: number }>(
    await tx.execute(sql`SELECT version_id, node_key, name, seq FROM approval_process_nodes
      WHERE tenant_id = ${tenantId}
        AND version_id = ANY(${`{${processesRows.map((p) => p.version_id).join(',')}}`}::uuid[])
      ORDER BY version_id, seq`),
  );
  return processesRows.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    approvalType: p.approval_type,
    nodes: nodes
      .filter((n) => n.version_id === p.version_id)
      .map((n) => ({ nodeKey: n.node_key, name: n.name, seq: Number(n.seq) })),
  }));
}

// ---- 模板 ----

function registerTemplateRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const path = `${BASE}/templates`;
  router.get(path, async (c) => {
    const ctx = await idpContext(c, deps, 'template');
    const page = pageQuery(c);
    const scope = await idpScope(c, deps, ctx, 'template');
    const visible = readableSql(ctx, scope, {
      org: sql`org_id`,
      publicDown: sql`public_down`,
      creator: sql`created_by`,
    });
    const status = enumQuery(c, 'status', ['draft', 'published'] as const);
    const processId = uuidQuery(c, 'processId');
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      read.listTemplates(tx, ctx.tenantId, { ...page, status, processId, visible }),
    );
    const present = await templatePresenter(deps, ctx);
    return c.json({ ...listEnvelope(page, scope), items: items.map(present) });
  });

  router.get(`${path}/:id`, async (c) => {
    const ctx = await idpContext(c, deps, 'template');
    const id = uuidParam(c);
    const scope = await idpScope(c, deps, ctx, 'template');
    const found = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const view = await read.loadTemplate(tx, ctx.tenantId, id);
      if (!view) throw new AppError('NOT_FOUND', '发展计划模板不存在');
      await requireReadable(tx, ctx, scope, 'template', anchorOf(view));
      return view;
    });
    c.header('ETag', `"${found.revision}"`);
    return c.json((await templatePresenter(deps, ctx))(found));
  });
}

/** 模板写入（模块与通用目标以外）：共用执行器，返回前按 recheck 复核当前归属与引用。 */
function templateWriter(deps: TenantRouteDeps) {
  return <T extends read.TemplateView & { warnings?: readonly unknown[] }>(
    c: Context<TenantEnv>,
    ctx: IdpContext,
    status: 200 | 201,
    body: unknown,
    execute: (tx: Tx, w: WriteContext) => Promise<T>,
    recheck: (tx: Tx, scope: ModuleScope, view: T) => Promise<void>,
  ) =>
    runIdpWrite<T>(c, deps, ctx, {
      anchorObject: 'template',
      status,
      body,
      execute,
      recheck,
      present: async ({ warnings, ...view }) => ({
        ...(await templatePresenter(deps, ctx))(view),
        // 发布提示（DEC-309④-3）：协议元数据，不是模板字段
        ...(warnings ? { warnings } : {}),
      }),
    });
}

/** 模板写入后：模板当前可写；引用的流程（新建 / 换流程 / 复制时）当前可见。 */
const editable =
  (ctx: IdpContext, process?: ModuleScope) => async (tx: Tx, scope: ModuleScope, view: read.TemplateView) => {
    await currentEditable(tx, ctx, scope, 'template', view.id);
    if (process) await currentReadable(tx, ctx, process, 'process', view.processId);
  };

function registerTemplateWrites(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const path = `${BASE}/templates`;
  const templateWrite = templateWriter(deps);

  router.post(path, async (c) => {
    const ctx = await writeContext(c, deps, 'template', 'create', 'create');
    requireNew(ctx);
    const body = await parseBody(c, input.templateCreate);
    await checkWriteFields(deps, ctx, 'template', 'create', body);
    const process = await processScopeFor(c, deps, ctx);
    return templateWrite(
      c,
      ctx,
      201,
      body,
      (tx, w) => templates.createTemplate(tx, w, { process }, body),
      editable(ctx, process),
    );
  });

  router.patch(`${path}/:id`, async (c) => {
    const ctx = await writeContext(c, deps, 'template', 'update', 'update');
    const id = uuidParam(c);
    const body = await parseBody(c, input.templatePatch);
    await checkWriteFields(deps, ctx, 'template', 'update', body);
    const process = body.processId ? await processScopeFor(c, deps, ctx) : undefined;
    return templateWrite(
      c,
      ctx,
      200,
      body,
      (tx, w) => templates.updateTemplate(tx, w, { process }, id, body),
      editable(ctx, process),
    );
  });

  router.delete(`${path}/:id`, async (c) => {
    const ctx = await writeContext(c, deps, 'template', 'delete', 'delete');
    const id = uuidParam(c);
    return templateWrite(
      c,
      ctx,
      200,
      { id },
      (tx, w) => templates.deleteTemplate(tx, deps, w, id),
      // 删除的受控快照：按删除时的归属判定当前可写性
      (tx, scope, view) => requireEditable(tx, ctx, scope, 'template', anchorOf(view)),
    );
  });
}

/** 复制、发布、取消发布。 */
function registerTemplateActions(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const path = `${BASE}/templates`;
  const templateWrite = templateWriter(deps);
  router.post(`${path}/:id/copy`, async (c) => {
    const ctx = await writeContext(c, deps, 'template', 'create', 'copy');
    requireNew(ctx);
    const id = uuidParam(c);
    const body = await parseBody(c, input.templateCopy);
    await checkWriteFields(deps, ctx, 'template', 'create', body);
    const process = await processScopeFor(c, deps, ctx);
    // 继承内容的字段投影在事务外按当前权限解析（事务内判定，P2-3）
    const projections = {
      template: await projectionOf(deps, ctx, 'template'),
      templateModule: await projectionOf(deps, ctx, 'templateModule'),
      commonGoal: await projectionOf(deps, ctx, 'commonGoal'),
    };
    return templateWrite(
      c,
      ctx,
      201,
      body,
      (tx, w) => templates.copyTemplate(tx, deps, w, { process, projections }, id, body),
      async (tx, scope, view) => {
        await editable(ctx, process)(tx, scope, view);
        await currentReadable(tx, ctx, scope, 'template', id);
      },
    );
  });

  for (const [action, status] of [
    ['publish', 'published'],
    ['unpublish', 'draft'],
  ] as const) {
    router.post(`${path}/:id/${action}`, async (c) => {
      const ctx = await writeContext(c, deps, 'template', 'update', action);
      const id = uuidParam(c);
      return templateWrite(
        c,
        ctx,
        200,
        { id, action },
        (tx, w) => templates.setTemplateStatus(tx, w, id, status),
        editable(ctx),
      );
    });
  }
}

// ---- 模块与通用目标（模板的组成部分，If-Match = 模板 revision） ----

function registerTemplatePartRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const path = `${BASE}/templates/:id`;
  const write =
    <B extends object>(
      object: 'templateModule' | 'commonGoal',
      operation: 'create' | 'update' | 'delete',
      schema: z.ZodType<B> | null,
      execute: (
        tx: Tx,
        w: WriteContext,
        templateId: string,
        partId: string | undefined,
        body: B,
      ) => Promise<read.TemplateView>,
    ) =>
    async (c: Context<TenantEnv>) => {
      const ctx = await idpWriteContext(
        c,
        deps,
        object,
        operation,
        operation,
        operation === 'create' ? 'list' : 'detail',
        revision(c),
      );
      const templateId = uuidParam(c);
      const partId = operation === 'create' ? undefined : uuidParam(c, 'partId');
      const body = (schema ? await parseBody(c, schema) : {}) as B;
      if (operation !== 'delete') await checkWriteFields(deps, ctx, object, operation, body as Record<string, unknown>);
      return runIdpWrite<read.TemplateView>(c, deps, ctx, {
        anchorObject: 'template',
        status: operation === 'create' ? 201 : 200,
        body: { partId, body },
        execute: (tx, w) => execute(tx, w, templateId, partId, body),
        recheck: (tx, scope) => currentEditable(tx, ctx, scope, 'template', templateId),
        present: async (view) => (await templatePresenter(deps, ctx))(view),
      });
    };

  router.post(
    `${path}/modules`,
    write('templateModule', 'create', input.moduleCreate, (tx, w, id, _p, body) =>
      templates.addModule(tx, w, id, body),
    ),
  );
  router.patch(
    `${path}/modules/:partId`,
    write('templateModule', 'update', input.modulePatch, (tx, w, id, part, body) =>
      templates.updateModule(tx, w, id, part!, body),
    ),
  );
  router.delete(
    `${path}/modules/:partId`,
    write('templateModule', 'delete', null, (tx, w, id, part) => templates.deleteModule(tx, deps, w, id, part!)),
  );
  router.post(
    `${path}/common-goals`,
    write('commonGoal', 'create', input.commonGoalCreate, (tx, w, id, _p, body) =>
      templates.addCommonGoal(tx, w, id, body),
    ),
  );
  router.patch(
    `${path}/common-goals/:partId`,
    write('commonGoal', 'update', input.commonGoalPatch, (tx, w, id, part, body) =>
      templates.updateCommonGoal(tx, w, id, part!, body),
    ),
  );
  router.delete(
    `${path}/common-goals/:partId`,
    write('commonGoal', 'delete', null, (tx, w, id, part) => templates.deleteCommonGoal(tx, w, id, part!)),
  );
}
