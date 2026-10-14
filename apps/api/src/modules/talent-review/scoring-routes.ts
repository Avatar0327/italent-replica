/**
 * R3-T04 PR-B2a / B2b 接口（设计 §7 配置 CRUD 行；前缀 /api/tenant/talent-review）：评价规则 score-rules、模块等级 module-grades、
 * 字段映射 field-mappings（B2b，另需字段对象的查看权与范围）。
 * 读写模式同 B1（config-routes.ts）：没有组织字段，列表按创建人谓词分页前过滤，范围外与不存在同一个 404，
 * 写入走命令台账并按当前权限复核。
 * 路由权限声明见 docs/08_设计/R3-T04_PR-B2a_路由声明.md、R3-T04_PR-B2b_路由声明.md。
 */
import { type Tx, withTenant } from '@italent/db';
import type { Context, Hono } from 'hono';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  authorizeInTransaction,
  getModuleViewableFields,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { pageQuery, parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
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
import {
  mappingCreate,
  mappingPatch,
  moduleGradeCreate,
  moduleGradePatch,
  scoreRuleCreate,
  scoreRulePatch,
} from './config-input.js';
import { deleteConfig, loadConfig, type WriteContext } from './config-kit.js';
import { detailResponse, listResponse, type Viewed, visibleTo } from './config-routes.js';
import * as mappings from './mapping-service.js';
import * as grades from './module-grade-service.js';
import * as rules from './score-rule-service.js';

const SCORE_RULES = `${TALENT_REVIEW_BASE}/score-rules`;
const MODULE_GRADES = `${TALENT_REVIEW_BASE}/module-grades`;
const MAPPINGS = `${TALENT_REVIEW_BASE}/field-mappings`;

type ScoringObject = 'scoreRule' | 'moduleGrade' | 'mapping';
type WriteOperation = 'create' | 'update' | 'delete';

/**
 * 命令事务内的当前权限复核（DEC-388①，第 1 轮审查 P2-01）：操作权、按钮、提交字段的编辑权和数据范围都在命令事务内按
 * 当前授权重新解析；首次执行、直接重放与“失败后回查台账”三个出口都经过它，撤权后首次写入整体回滚（业务、revision、审计、
 * 台账都不提交），重放不返回首次结果。
 */
async function recheck(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tx: Tx,
  ctx: TalentReviewContext,
  object: ScoringObject,
  operation: WriteOperation,
): Promise<{ readonly txDeps: TenantRouteDeps; readonly fresh: TalentReviewContext; readonly write: WriteContext }> {
  const txDeps: TenantRouteDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const fresh = await reviewWriteContext(c, txDeps, object, operation, ctx.expectedRevision);
  const scope = await resolveModuleScopeInTransaction(txDeps, fresh, tx, codeOf(object));
  return { txDeps, fresh, write: { ...fresh, scope } };
}

/** 新建 / 修改另复核提交字段的编辑权（含显式清空）；删除没有字段输入，只复核对象操作权、按钮与范围。 */
async function recheckFields(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tx: Tx,
  ctx: TalentReviewContext,
  object: ScoringObject,
  operation: 'create' | 'update',
  body: object,
): Promise<WriteContext> {
  const { txDeps, fresh, write } = await recheck(c, deps, tx, ctx, object, operation);
  await checkWriteFields(txDeps, fresh, object, operation, body as Record<string, unknown>);
  return write;
}

type Execute<V> = (tx: Tx, ctx: WriteContext) => Promise<V>;

/** 新建 / 修改：事务内复核含字段编辑权。 */
function runScoringWrite<V extends Viewed>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  object: ScoringObject,
  operation: 'create' | 'update',
  body: object,
  status: 200 | 201,
  execute: Execute<V>,
  /** 事务内的附加复核（字段映射：引用字段对象的查看权与范围），与主复核同一出口。 */
  alsoInTx?: (tx: Tx) => Promise<void>,
  /** 重放台账结果时的附加复核（字段映射：结果引用的字段按当前字段目录范围仍须可见）。 */
  alsoOnReplay?: (tx: Tx, view: V) => Promise<void>,
) {
  const before = async (tx: Tx) => {
    const write = await recheckFields(c, deps, tx, ctx, object, operation, body);
    await alsoInTx?.(tx);
    return write;
  };
  return runGuarded(c, deps, ctx, object, body, status, execute, before, alsoOnReplay);
}

/** 删除：没有字段输入，事务内只复核对象操作权、按钮与范围。 */
function runScoringDelete<V extends Viewed>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  object: ScoringObject,
  id: string,
  execute: Execute<V>,
) {
  const before = async (tx: Tx) => (await recheck(c, deps, tx, ctx, object, 'delete')).write;
  return runGuarded(c, deps, ctx, object, { id }, 200, execute, before);
}

/** 写命令：事务内复核 + 台账；返回台账结果时结果对象按当前范围仍须可见（撤权后 404），响应按当前字段权限裁剪。 */
async function runGuarded<V extends Viewed>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  object: ScoringObject,
  body: object,
  status: 200 | 201,
  execute: Execute<V>,
  recheckInTx: (tx: Tx) => Promise<WriteContext>,
  alsoOnReplay?: (tx: Tx, view: V) => Promise<void>,
) {
  let current: WriteContext | undefined;
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input: body },
    guard: {
      before: async (tx) => {
        current = await recheckInTx(tx);
      },
      replayed: async (tx, replay) => {
        visibleTo(object)(current!.scope, replay.body as Viewed);
        await alsoOnReplay?.(tx, replay.body as V);
      },
    },
    execute: async (tx, commandId) => ({ status, body: await execute(tx, { ...current!, commandId }) }),
  });
  const view = result.body as V;
  if (c.req.method !== 'DELETE') c.header('ETag', `"${view.revision}"`);
  return c.json((await trimReview(deps, ctx, object, [view]))[0], result.status);
}

export function registerScoringRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerScoreRules(router, deps);
  registerModuleGrades(router, deps);
  registerMappings(router, deps);
}

function registerScoreRules(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(SCORE_RULES, async (c) => {
    const ctx = await reviewContext(c, deps, 'scoreRule');
    return listResponse(c, deps, ctx, 'scoreRule', 'talent_review_score_rules', rules.SCORE_RULE, (tx, found) =>
      rules.withLevels(tx, ctx.tenantId, found as never),
    );
  });
  router.get(`${SCORE_RULES}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'scoreRule');
    return detailResponse(c, deps, ctx, 'scoreRule', rules.SCORE_RULE);
  });
  router.post(SCORE_RULES, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'scoreRule', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, scoreRuleCreate);
    await checkWriteFields(deps, ctx, 'scoreRule', 'create', body);
    return runScoringWrite(c, deps, ctx, 'scoreRule', 'create', body, 201, (tx, w) =>
      rules.createScoreRule(tx, w, body),
    );
  });
  router.patch(`${SCORE_RULES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'scoreRule', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, scoreRulePatch);
    await checkWriteFields(deps, ctx, 'scoreRule', 'update', body);
    return runScoringWrite(c, deps, ctx, 'scoreRule', 'update', body, 200, (tx, w) =>
      rules.updateScoreRule(tx, w, id, body),
    );
  });
  router.delete(`${SCORE_RULES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'scoreRule', 'delete', revision(c));
    const id = uuidParam(c);
    return runScoringDelete(c, deps, ctx, 'scoreRule', id, (tx, w) => deleteConfig(tx, rules.SCORE_RULE, w, id));
  });
}

function registerModuleGrades(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(MODULE_GRADES, async (c) => {
    const ctx = await reviewContext(c, deps, 'moduleGrade');
    return listResponse(c, deps, ctx, 'moduleGrade', 'talent_review_module_grades', grades.MODULE_GRADE, (tx, found) =>
      grades.withItems(tx, ctx.tenantId, found as never),
    );
  });
  router.get(`${MODULE_GRADES}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'moduleGrade');
    return detailResponse(c, deps, ctx, 'moduleGrade', grades.MODULE_GRADE);
  });
  router.post(MODULE_GRADES, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'moduleGrade', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, moduleGradeCreate);
    await checkWriteFields(deps, ctx, 'moduleGrade', 'create', body);
    return runScoringWrite(c, deps, ctx, 'moduleGrade', 'create', body, 201, (tx, w) =>
      grades.createModuleGrade(tx, w, body),
    );
  });
  router.patch(`${MODULE_GRADES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'moduleGrade', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, moduleGradePatch);
    await checkWriteFields(deps, ctx, 'moduleGrade', 'update', body);
    return runScoringWrite(c, deps, ctx, 'moduleGrade', 'update', body, 200, (tx, w) =>
      grades.updateModuleGrade(tx, w, id, body),
    );
  });
  router.delete(`${MODULE_GRADES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'moduleGrade', 'delete', revision(c));
    const id = uuidParam(c);
    return runScoringDelete(c, deps, ctx, 'moduleGrade', id, (tx, w) => deleteConfig(tx, grades.MODULE_GRADE, w, id));
  });
}

/**
 * 字段映射引用字段 = 读取字段对象：另需字段对象的查看权（403）与范围；命令里不存在与范围外同一个 404。
 * 路由层先校验一次（尽早拒绝），命令事务内按当前授权再解析一次（传 tx：首次执行、直接重放、失败后回查都经过）。
 */
async function requireMappingFields(c: Context<TenantEnv>, deps: TenantRouteDeps, tx?: Tx): Promise<ModuleScope> {
  const txDeps: TenantRouteDeps = tx ? { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) } : deps;
  const ctx = await reviewContext(c, txDeps, 'field');
  return tx ? resolveModuleScopeInTransaction(txDeps, ctx, tx, codeOf('field')) : reviewScope(c, txDeps, ctx, 'field');
}

function registerMappingReads(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(MAPPINGS, async (c) => {
    const ctx = await reviewContext(c, deps, 'mapping');
    const page = pageQuery(c);
    const scene = c.req.query('scene') || undefined;
    // 筛选字段同样受字段查看权约束：看不到 scene 的人不能用筛选还原场景
    if (scene !== undefined) await requireFilterVisible(deps, ctx, 'mapping', 'scene');
    const scope = await reviewScope(c, deps, ctx, 'mapping');
    const viewable = await getModuleViewableFields(deps, ctx, codeOf('mapping'));
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      mappings.listMappings(tx, ctx.tenantId, {
        ...page,
        scene,
        visible: configScopeSql(scope, 'talent_review_field_mappings'),
        viewable,
      }),
    );
    return c.json({ ...configEnvelope(page, scope), items: await trimReview(deps, ctx, 'mapping', items) });
  });
  router.get(`${MAPPINGS}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'mapping');
    const id = uuidParam(c);
    const scope = await reviewScope(c, deps, ctx, 'mapping');
    const found = await withTenant(deps.db, ctx.tenantId, (tx) => loadConfig(tx, mappings.MAPPING, ctx.tenantId, id));
    if (!found) throw new AppError('NOT_FOUND', notFoundMessage('mapping'));
    requireConfigVisible(scope, 'mapping', found.createdBy);
    c.header('ETag', `"${found.revision}"`);
    return c.json((await trimReview(deps, ctx, 'mapping', [found]))[0]);
  });
}

function registerMappings(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerMappingReads(router, deps);
  router.post(MAPPINGS, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'mapping', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, mappingCreate);
    await checkWriteFields(deps, ctx, 'mapping', 'create', body);
    await requireMappingFields(c, deps);
    let fieldScope: ModuleScope | undefined;
    return runScoringWrite(
      c,
      deps,
      ctx,
      'mapping',
      'create',
      body,
      201,
      (tx, w) => mappings.createMapping(tx, w, fieldScope!, body),
      async (tx) => {
        fieldScope = await requireMappingFields(c, deps, tx);
      },
      (tx, view) => mappings.requireReferencedFieldsVisible(tx, ctx.tenantId, fieldScope!, view),
    );
  });
  router.patch(`${MAPPINGS}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'mapping', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, mappingPatch);
    await checkWriteFields(deps, ctx, 'mapping', 'update', body);
    const touched = body.sourceFieldId !== undefined || body.targetFieldId !== undefined;
    if (touched) await requireMappingFields(c, deps);
    let fieldScope: ModuleScope | undefined;
    return runScoringWrite(
      c,
      deps,
      ctx,
      'mapping',
      'update',
      body,
      200,
      (tx, w) => mappings.updateMapping(tx, w, fieldScope, id, body),
      async (tx) => {
        fieldScope = touched ? await requireMappingFields(c, deps, tx) : undefined;
      },
      // 本次改了来源 / 目标字段时，重放结果引用的字段也须按当前字段目录范围仍可见
      async (tx, view) => {
        if (touched) await mappings.requireReferencedFieldsVisible(tx, ctx.tenantId, fieldScope!, view);
      },
    );
  });
  router.delete(`${MAPPINGS}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'mapping', 'delete', revision(c));
    const id = uuidParam(c);
    return runScoringDelete(c, deps, ctx, 'mapping', id, (tx, w) =>
      deleteConfig(tx, mappings.MAPPING, w, id, (before) => {
        if (before.preset) throw new AppError('CONFLICT', '预置映射不能删除', { reason: 'MAPPING_PRESET' });
      }),
    );
  });
}
