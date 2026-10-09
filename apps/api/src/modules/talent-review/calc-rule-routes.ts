/**
 * R3-T04 PR-B5 计算规则接口（设计 §2.2、§7 计算规则行；前缀 /api/tenant/talent-review/calc-rules）：规则 + 计算项目聚合的
 * 增删改查。路由权限声明见 docs/08_设计/R3-T04_PR-B5_路由声明.md。写入走命令台账（幂等、If-Match revision 409），首次执行与
 * 幂等重放都按当前功能权限、按钮与范围复核，响应按当前字段裁剪。没有组织字段：列表按创建人谓词（分页之前）过滤，
 * 详情 / 写入范围外与不存在同一个 404，新建只有看全部可建。提交计算项目（公式与目标字段引用盘点字段目录）另需字段目录的
 * 对象查看权（requireCatalogAccess），公式与目标字段只在其可见字段里解析。
 */
import { withTenant, type Tx } from '@italent/db';
import type { Context, Hono } from 'hono';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { booleanQuery, pageQuery, parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import { getModuleViewableFields } from '../permission/module-access.js';
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
  type TalentReviewContext,
} from './access.js';
import { type CalcItemBody, calcRuleCreate, type CalcRulePatch, calcRulePatch } from './calc-rule-input.js';
import * as rules from './calc-rule-service.js';
import type { CatalogAccess } from './calc-rule-service.js';
import {
  CALC_RULE,
  type CalcRuleRow,
  type CalcRuleView,
  loadCalcRuleView,
  visibleOrder,
  withItems,
} from './calc-rule-view.js';
import { listConfig } from './config-kit.js';

const CALC_RULES = `${TALENT_REVIEW_BASE}/calc-rules`;

/** 引用盘点字段需要查看人对字段目录这四列的查看权（名称、类型、启用状态、系统写入）。 */
const REFERENCE_COLUMNS = ['name', 'kind', 'enabled', 'systemWritten'];

/**
 * 公式与目标字段引用盘点字段目录 = 读取字段目录：另需字段目录的对象查看权，并按其范围与列权限解析可引用的字段。
 */
async function requireCatalogAccess(c: Context<TenantEnv>, deps: TenantRouteDeps): Promise<CatalogAccess> {
  const ctx = await reviewContext(c, deps, 'field');
  const scope = await reviewScope(c, deps, ctx, 'field');
  const viewable = await getModuleViewableFields(deps, ctx, codeOf('field'));
  return { scope, columns: viewable === undefined || REFERENCE_COLUMNS.every((column) => viewable.has(column)) };
}

/**
 * 只提交启用时不拒绝没有字段目录查看权的人（启用不引用新字段）；提示照常检测，看不到的字段一律不显示名称（presentHints），
 * 不静默省略（DEC-274）。
 */
async function optionalCatalogAccess(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  try {
    return await requireCatalogAccess(c, deps);
  } catch (error) {
    if (error instanceof AppError && error.code === 'FORBIDDEN') return undefined;
    throw error;
  }
}

/** 提交计算项目必须有字段目录访问；只提交启用时字段目录访问只决定提示里显示哪些字段名。 */
function patchCatalogAccess(c: Context<TenantEnv>, deps: TenantRouteDeps, body: CalcRulePatch) {
  if (body.items !== undefined) return requireCatalogAccess(c, deps);
  return body.enabled === true ? optionalCatalogAccess(c, deps) : Promise.resolve(undefined);
}

/**
 * 命令执行：范围在事务外按当前权限解析，首次执行在事务内行锁后复核；幂等重放按当前范围复核结果对象
 * （撤范围后重放 404，AGENTS §10），响应按当前字段权限裁剪。保存 / 启用提示（hinted）不进命令台账，
 * 每次响应按当前字段目录授权重新生成（首次与重放同一套裁剪）。
 */
async function runWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  body: object,
  status: 200 | 201,
  execute: (tx: Tx, ctx: rules.CalcWriteContext) => Promise<CalcRuleView>,
  options: { fieldAccess?: CatalogAccess; referenced?: readonly CalcItemBody[]; hinted?: boolean } = {},
) {
  const { fieldAccess, referenced = [], hinted = false } = options;
  const scope = await reviewScope(c, deps, ctx, 'calcRule');
  // 引用范围的授权复核放在命令之前（只读、不写任何东西）：幂等重放不再执行命令，撤范围后重放按新命令同样拒绝；
  // 首次执行在命令事务内还会再判一次（prepareItems），拒绝时整个事务回滚，不留业务、revision、台账与审计
  if (fieldAccess && referenced.length > 0) {
    await withTenant(deps.db, ctx.tenantId, (tx) =>
      rules.requireItemsReferenceable(tx, ctx.tenantId, referenced, fieldAccess),
    );
  }
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input: body },
    execute: async (tx, commandId) => ({
      status,
      body: await execute(tx, { ...ctx, commandId, scope, ...(fieldAccess ? { fieldAccess } : {}) }),
    }),
  });
  // 台账里缓存的结果不带提示；旧版本缓存过的提示也一律丢弃，不原样返回
  const { hints: _cached, ...stored } = result.body as rules.CalcWriteView;
  requireConfigVisible(scope, 'calcRule', stored.createdBy as string | null);
  const view: rules.CalcWriteView = hinted
    ? {
        ...stored,
        hints: await withTenant(deps.db, ctx.tenantId, (tx) =>
          rules.presentHints(tx, ctx.tenantId, stored.items, fieldAccess),
        ),
      }
    : stored;
  if (c.req.method !== 'DELETE') c.header('ETag', `"${view.revision}"`);
  return c.json((await trimReview(deps, ctx, 'calcRule', [view]))[0], result.status);
}

export function registerCalcRuleRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(CALC_RULES, async (c) => {
    const ctx = await reviewContext(c, deps, 'calcRule');
    const page = pageQuery(c);
    const enabled = booleanQuery(c, 'enabled');
    // 筛选字段同样受字段查看权约束：看不到 enabled 的人不能用筛选还原启用状态
    if (enabled !== undefined) await requireFilterVisible(deps, ctx, 'calcRule', 'enabled');
    const scope = await reviewScope(c, deps, ctx, 'calcRule');
    const orderBy = visibleOrder(await getModuleViewableFields(deps, ctx, codeOf('calcRule')));
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const found = await listConfig(tx, CALC_RULE, ctx.tenantId, {
        ...page,
        orderBy,
        enabled,
        visible: configScopeSql(scope, 'talent_review_calc_rules'),
      });
      return withItems(tx, ctx.tenantId, found as CalcRuleRow[]);
    });
    return c.json({ ...configEnvelope(page, scope), items: await trimReview(deps, ctx, 'calcRule', items) });
  });
  router.get(`${CALC_RULES}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'calcRule');
    const id = uuidParam(c);
    const scope = await reviewScope(c, deps, ctx, 'calcRule');
    const found = await withTenant(deps.db, ctx.tenantId, (tx) => loadCalcRuleView(tx, ctx.tenantId, id));
    // 不存在与范围外同一个 404，不泄露对象是否存在
    if (!found) throw new AppError('NOT_FOUND', notFoundMessage('calcRule'));
    requireConfigVisible(scope, 'calcRule', found.createdBy as string | null);
    c.header('ETag', `"${found.revision}"`);
    return c.json((await trimReview(deps, ctx, 'calcRule', [found]))[0]);
  });
  router.post(CALC_RULES, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'calcRule', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, calcRuleCreate);
    await checkWriteFields(deps, ctx, 'calcRule', 'create', body);
    const access = await requireCatalogAccess(c, deps);
    return runWrite(c, deps, ctx, body, 201, (tx, w) => rules.createCalcRule(tx, w, body), {
      fieldAccess: access,
      referenced: body.items,
      hinted: true,
    });
  });
  router.patch(`${CALC_RULES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'calcRule', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, calcRulePatch);
    await checkWriteFields(deps, ctx, 'calcRule', 'update', body);
    const access = await patchCatalogAccess(c, deps, body);
    return runWrite(c, deps, ctx, body, 200, (tx, w) => rules.updateCalcRule(tx, w, id, body), {
      ...(access ? { fieldAccess: access } : {}),
      referenced: body.items ?? [],
      hinted: body.items !== undefined || body.enabled === true,
    });
  });
  router.delete(`${CALC_RULES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'calcRule', 'delete', revision(c));
    const id = uuidParam(c);
    return runWrite(c, deps, ctx, { id }, 200, (tx, w) => rules.deleteCalcRule(tx, w, id));
  });
}
