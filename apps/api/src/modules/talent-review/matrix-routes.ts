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
  authorizeInTransaction,
  getModuleViewableFields,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import {
  checkWriteFields,
  codeOf,
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
import { matrixCreate, type MatrixPatch, matrixPatch, ratioGroupCreate, ratioGroupPatch } from './matrix-input.js';
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
/** 请求体里引用的字段 id（轴、第三维度、位置字段）。 */
const referencedFields = (body: Partial<MatrixPatch>): string[] =>
  [body.xFieldId, body.yFieldId, body.zFieldId, ...(body.positionFields ?? []).map((p) => p.fieldId)].filter(
    (id): id is string => typeof id === 'string',
  );

/** 命令事务内要重新复核的内容：操作种类、请求里引用的盘点字段。 */
interface WriteRecheck {
  /** 规则组写入的权限是九宫格的 update。 */
  readonly operation: 'create' | 'update' | 'delete';
  readonly references: readonly string[];
}
interface Rechecked {
  readonly txDeps: TenantRouteDeps;
  readonly ctx: TalentReviewContext;
  readonly scope: ModuleScope;
  readonly fieldScope?: ModuleScope;
}

/**
 * 命令事务内的当前权限复核（首次执行、直接重放、失败后回查三条路径都经过 commands.ts 的 ledgerExit → guard.before；
 * AGENTS §10 权限、DEC-067、DEC-388①）：对象数据操作权、按钮、九宫格范围、引用字段的字段目录权限与范围都在**事务内**按
 * 当前授权重新解析，不沿用事务外保存的快照。拒绝即整体回滚：业务写、revision、审计、命令台账都不提交。
 */
async function recheck(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tx: Tx,
  expectedRevision: number,
  spec: WriteRecheck,
): Promise<Rechecked> {
  const txDeps: TenantRouteDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const ctx = await reviewWriteContext(c, txDeps, 'matrix', spec.operation, expectedRevision);
  const scope = await resolveModuleScopeInTransaction(txDeps, ctx, tx, codeOf('matrix'));
  if (spec.references.length === 0) return { txDeps, ctx, scope };
  // 引用盘点字段 = 读取字段目录：另需字段目录的对象查看权，并按其范围判定字段可见性（看不到的字段与不存在同为 404）
  await reviewContext(c, txDeps, 'field');
  const fieldScope = await resolveModuleScopeInTransaction(txDeps, ctx, tx, codeOf('field'));
  return { txDeps, ctx, scope, fieldScope };
}

/** 新建 / 修改 / 规则组写入：另复核载荷逐字段的编辑权（含显式清空）。 */
async function recheckFields(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tx: Tx,
  expectedRevision: number,
  spec: WriteRecheck,
  fields: Readonly<Record<string, unknown>>,
): Promise<Rechecked> {
  const checked = await recheck(c, deps, tx, expectedRevision, spec);
  await checkWriteFields(
    checked.txDeps,
    checked.ctx,
    'matrix',
    spec.operation === 'create' ? 'create' : 'update',
    fields,
  );
  return checked;
}

/**
 * 命令执行：权限与范围在命令事务内按当前授权复核（`guard.before`，写入之前）；返回台账结果时（直接重放、失败后回查）结果
 * 对象与请求里的字段引用按当前范围仍须可见（`guard.replayed`，撤权后 404），响应按当前字段权限裁剪。
 */
async function runGuarded(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  body: object,
  status: 200 | 201,
  spec: WriteRecheck,
  recheckInTx: (tx: Tx) => Promise<Rechecked>,
  execute: (tx: Tx, ctx: matrices.MatrixWriteContext) => Promise<MatrixView>,
) {
  let current: Rechecked | undefined;
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input: body },
    guard: {
      before: async (tx) => {
        current = await recheckInTx(tx);
      },
      replayed: async (tx, replay) => {
        const { scope, fieldScope } = current!;
        requireConfigVisible(scope, 'matrix', (replay.body as MatrixView).createdBy as string | null);
        if (fieldScope && spec.references.length > 0) {
          await matrices.requireReferencesVisible(tx, ctx.tenantId, spec.references, fieldScope);
        }
      },
    },
    execute: async (tx, commandId) => {
      const { ctx: fresh, scope, fieldScope } = current!;
      const view = await execute(tx, {
        ...fresh,
        commandId,
        scope,
        references: spec.references,
        ...(fieldScope ? { fieldScope } : {}),
      });
      return { status, body: view };
    },
  });
  const view = result.body as MatrixView;
  requireConfigVisible(current!.scope, 'matrix', view.createdBy as string | null);
  if (c.req.method !== 'DELETE') c.header('ETag', `"${view.revision}"`);
  return c.json((await trimReview(deps, ctx, 'matrix', [view]))[0], result.status);
}

type Execute = (tx: Tx, ctx: matrices.MatrixWriteContext) => Promise<MatrixView>;

/** 新建 / 修改 / 规则组写入：事务内复核操作权、按钮、范围、引用字段与载荷字段编辑权。 */
function runWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  body: object,
  status: 200 | 201,
  spec: WriteRecheck,
  fields: Readonly<Record<string, unknown>>,
  execute: Execute,
) {
  const before = (tx: Tx) => recheckFields(c, deps, tx, ctx.expectedRevision, spec, fields);
  return runGuarded(c, deps, ctx, body, status, spec, before, execute);
}

/** 删除九宫格：无字段输入，只复核操作权、按钮与范围。 */
function runDelete(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  body: object,
  execute: Execute,
) {
  const spec: WriteRecheck = { operation: 'delete', references: [] };
  return runGuarded(c, deps, ctx, body, 200, spec, (tx) => recheck(c, deps, tx, ctx.expectedRevision, spec), execute);
}

export function registerMatrixRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(MATRICES, async (c) => {
    const ctx = await reviewContext(c, deps, 'matrix');
    const page = pageQuery(c);
    const enabled = booleanQuery(c, 'enabled');
    // 筛选字段同样受字段查看权约束：看不到 enabled 的人不能用筛选还原启用状态
    if (enabled !== undefined) await requireFilterVisible(deps, ctx, 'matrix', 'enabled');
    const scope = await reviewScope(c, deps, ctx, 'matrix');
    const viewable = await getModuleViewableFields(deps, ctx, codeOf('matrix'));
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const rows = await listConfig(tx, MATRIX, ctx.tenantId, {
        ...page,
        viewable,
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
    // 路由层的前置检查只管早失败；以命令事务内的复核（runWrite）为准
    await requireFieldReference(c, deps);
    const spec = { operation: 'create', references: referencedFields(body) } as const;
    return runWrite(c, deps, ctx, body, 201, spec, body, (tx, w) => matrices.createMatrix(tx, w, body));
  });
  router.patch(`${MATRICES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'matrix', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, matrixPatch);
    await checkWriteFields(deps, ctx, 'matrix', 'update', body);
    const references = referencedFields(body);
    if (references.length > 0) await requireFieldReference(c, deps);
    const spec = { operation: 'update', references } as const;
    return runWrite(c, deps, ctx, body, 200, spec, body, (tx, w) => matrices.updateMatrix(tx, w, id, body));
  });
  router.delete(`${MATRICES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'matrix', 'delete', revision(c));
    const id = uuidParam(c);
    return runDelete(c, deps, ctx, { id }, (tx, w) => matrices.deleteMatrix(tx, w, id));
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
    const spec = { operation: 'update', references: [] } as const;
    const fields = { ratioGroups: body };
    return runWrite(c, deps, ctx, body, 201, spec, fields, (tx, w) => matrices.createRatioGroup(tx, w, id, body));
  });
  router.patch(`${GROUPS}/:groupId`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'matrix', 'update', revision(c));
    const id = uuidParam(c);
    const groupId = uuidParam(c, 'groupId');
    const body = await parseBody(c, ratioGroupPatch);
    await checkWriteFields(deps, ctx, 'matrix', 'update', { ratioGroups: body });
    const spec = { operation: 'update', references: [] } as const;
    const fields = { ratioGroups: body };
    return runWrite(c, deps, ctx, body, 200, spec, fields, (tx, w) =>
      matrices.updateRatioGroup(tx, w, id, groupId, body),
    );
  });
  router.delete(`${GROUPS}/:groupId`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'matrix', 'update', revision(c));
    const id = uuidParam(c);
    const groupId = uuidParam(c, 'groupId');
    await checkWriteFields(deps, ctx, 'matrix', 'update', { ratioGroups: [] });
    const spec = { operation: 'update', references: [] } as const;
    return runWrite(c, deps, ctx, { id, groupId }, 200, spec, { ratioGroups: [] }, (tx, w) =>
      matrices.deleteRatioGroup(tx, w, id, groupId),
    );
  });
}
