/**
 * R3-T04 PR-B2a 接口（设计 §7 配置 CRUD 行；前缀 /api/tenant/talent-review）：评价规则 score-rules、模块等级 module-grades。
 * 读写模式同 B1（config-routes.ts）：没有组织字段，列表按创建人谓词分页前过滤，范围外与不存在同一个 404，
 * 写入走命令台账并按当前权限复核。
 * 路由权限声明见 docs/08_设计/R3-T04_PR-B2a_路由声明.md。
 */
import type { Tx } from '@italent/db';
import type { Context, Hono } from 'hono';
import { runCommand } from '../../commands.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import {
  checkWriteFields,
  codeOf,
  reviewContext,
  reviewWriteContext,
  TALENT_REVIEW_BASE,
  trimReview,
  type TalentReviewContext,
} from './access.js';
import { moduleGradeCreate, moduleGradePatch, scoreRuleCreate, scoreRulePatch } from './config-input.js';
import { deleteConfig, type WriteContext } from './config-kit.js';
import { detailResponse, listResponse, type Viewed, visibleTo } from './config-routes.js';
import * as grades from './module-grade-service.js';
import * as rules from './score-rule-service.js';

const SCORE_RULES = `${TALENT_REVIEW_BASE}/score-rules`;
const MODULE_GRADES = `${TALENT_REVIEW_BASE}/module-grades`;

type ScoringObject = 'scoreRule' | 'moduleGrade';
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
) {
  const before = (tx: Tx) => recheckFields(c, deps, tx, ctx, object, operation, body);
  return runGuarded(c, deps, ctx, object, body, status, execute, before);
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
) {
  let current: WriteContext | undefined;
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input: body },
    guard: {
      before: async (tx) => {
        current = await recheckInTx(tx);
      },
      replayed: async (_tx, replay) => visibleTo(object)(current!.scope, replay.body as Viewed),
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
