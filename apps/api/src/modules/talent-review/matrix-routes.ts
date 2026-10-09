/**
 * R3-T04 PR-B4 九宫格接口（设计 §2.2、§7 九宫格 CRUD 行；前缀 /api/tenant/talent-review/matrices）：九宫格聚合（轴、分段、格子、
 * 位置字段占用）的增删改查，以及比例规则组的增改删（组 id 稳定，写入共用九宫格的 revision）。路由权限声明见
 * docs/08_设计/R3-T04_PR-B4_路由声明.md。写入走命令台账（幂等、If-Match revision 409），首次执行与幂等重放都按当前功能权限、
 * 按钮与范围复核，响应按当前字段裁剪。没有组织字段：列表按创建人谓词（分页之前）过滤，详情 / 写入范围外与不存在同一个 404，
 * 新建只有看全部可建。引用盘点字段（轴 / 位置字段）还须有字段目录的查看权（requireFieldReference），看不到的字段与不存在同为 404。
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
import { listConfig } from './config-kit.js';
import { matrixCreate, matrixPatch, ratioGroupCreate, ratioGroupPatch } from './matrix-input.js';
import * as matrices from './matrix-service.js';
import { loadMatrixView, MATRIX, type MatrixRow, type MatrixView, withChildren } from './matrix-view.js';

const MATRICES = `${TALENT_REVIEW_BASE}/matrices`;
const GROUPS = `${MATRICES}/:id/ratio-groups`;

/**
 * 引用盘点字段（轴 / 第三维度 / 位置字段）= 读取字段目录：另需字段目录的对象查看权，并按其范围判定字段可见性
 * （看不到的字段与不存在同一个 404，命令内判定）。请求不带字段引用时不需要。
 */
async function requireFieldReference(c: Context<TenantEnv>, deps: TenantRouteDeps): Promise<ModuleScope> {
  const ctx = await reviewContext(c, deps, 'field');
  return reviewScope(c, deps, ctx, 'field');
}
const REFERENCE_KEYS = ['xFieldId', 'yFieldId', 'zFieldId', 'positionFields'] as const;
const referencesFields = (body: object) => REFERENCE_KEYS.some((key) => (body as Record<string, unknown>)[key] != null);

/**
 * 命令执行：范围在事务外按当前权限解析，首次执行在事务内行锁后复核；幂等重放按当前范围复核结果对象
 * （撤范围后重放 404，AGENTS §10），响应按当前字段权限裁剪。
 */
async function runWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  body: object,
  status: 200 | 201,
  execute: (tx: Tx, ctx: matrices.MatrixWriteContext) => Promise<MatrixView>,
  fieldScope?: ModuleScope,
) {
  const scope = await reviewScope(c, deps, ctx, 'matrix');
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input: body },
    execute: async (tx, commandId) => ({
      status,
      body: await execute(tx, { ...ctx, commandId, scope, ...(fieldScope ? { fieldScope } : {}) }),
    }),
  });
  const view = result.body as MatrixView;
  requireConfigVisible(scope, 'matrix', view.createdBy as string | null);
  if (c.req.method !== 'DELETE') c.header('ETag', `"${view.revision}"`);
  return c.json((await trimReview(deps, ctx, 'matrix', [view]))[0], result.status);
}

export function registerMatrixRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(MATRICES, async (c) => {
    const ctx = await reviewContext(c, deps, 'matrix');
    const page = pageQuery(c);
    const enabled = booleanQuery(c, 'enabled');
    // 筛选字段同样受字段查看权约束：看不到 enabled 的人不能用筛选还原启用状态
    if (enabled !== undefined) await requireFilterVisible(deps, ctx, 'matrix', 'enabled');
    const scope = await reviewScope(c, deps, ctx, 'matrix');
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const rows = await listConfig(tx, MATRIX, ctx.tenantId, {
        ...page,
        enabled,
        visible: configScopeSql(scope, 'talent_review_matrices'),
      });
      return withChildren(tx, ctx.tenantId, rows as MatrixRow[]);
    });
    return c.json({ ...configEnvelope(page, scope), items: await trimReview(deps, ctx, 'matrix', items) });
  });
  router.get(`${MATRICES}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'matrix');
    const id = uuidParam(c);
    const scope = await reviewScope(c, deps, ctx, 'matrix');
    const found = await withTenant(deps.db, ctx.tenantId, (tx) => loadMatrixView(tx, ctx.tenantId, id));
    // 不存在与范围外同一个 404，不泄露对象是否存在
    if (!found) throw new AppError('NOT_FOUND', notFoundMessage('matrix'));
    requireConfigVisible(scope, 'matrix', found.createdBy as string | null);
    c.header('ETag', `"${found.revision}"`);
    return c.json((await trimReview(deps, ctx, 'matrix', [found]))[0]);
  });
  router.post(MATRICES, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'matrix', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, matrixCreate);
    await checkWriteFields(deps, ctx, 'matrix', 'create', body);
    const fieldScope = await requireFieldReference(c, deps);
    return runWrite(c, deps, ctx, body, 201, (tx, w) => matrices.createMatrix(tx, w, body), fieldScope);
  });
  router.patch(`${MATRICES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'matrix', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, matrixPatch);
    await checkWriteFields(deps, ctx, 'matrix', 'update', body);
    const fieldScope = referencesFields(body) ? await requireFieldReference(c, deps) : undefined;
    return runWrite(c, deps, ctx, body, 200, (tx, w) => matrices.updateMatrix(tx, w, id, body), fieldScope);
  });
  router.delete(`${MATRICES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'matrix', 'delete', revision(c));
    const id = uuidParam(c);
    return runWrite(c, deps, ctx, { id }, 200, (tx, w) => matrices.deleteMatrix(tx, w, id));
  });
  registerRatioGroupRoutes(router, deps);
}

/** 规则组是九宫格聚合的一部分：权限 = 九宫格的 update 操作 + update 按钮 + ratioGroups 字段编辑权。 */
function registerRatioGroupRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post(GROUPS, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'matrix', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, ratioGroupCreate);
    await checkWriteFields(deps, ctx, 'matrix', 'update', { ratioGroups: body });
    return runWrite(c, deps, ctx, body, 201, (tx, w) => matrices.createRatioGroup(tx, w, id, body));
  });
  router.patch(`${GROUPS}/:groupId`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'matrix', 'update', revision(c));
    const id = uuidParam(c);
    const groupId = uuidParam(c, 'groupId');
    const body = await parseBody(c, ratioGroupPatch);
    await checkWriteFields(deps, ctx, 'matrix', 'update', { ratioGroups: body });
    return runWrite(c, deps, ctx, body, 200, (tx, w) => matrices.updateRatioGroup(tx, w, id, groupId, body));
  });
  router.delete(`${GROUPS}/:groupId`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'matrix', 'update', revision(c));
    const id = uuidParam(c);
    const groupId = uuidParam(c, 'groupId');
    await checkWriteFields(deps, ctx, 'matrix', 'update', { ratioGroups: [] });
    return runWrite(c, deps, ctx, { id, groupId }, 200, (tx, w) => matrices.deleteRatioGroup(tx, w, id, groupId));
  });
}
