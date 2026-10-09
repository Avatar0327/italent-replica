/**
 * R3-T04 人才盘点接口（设计 §7；前缀 /api/tenant/talent-review）。PR-A 只有准备度字典 readiness-levels 的增删改查
 * （DEC-301①）；路由权限声明见 docs/08_设计/R3-T04_准备度字典_路由声明.md（F-039 格式）。
 * 写入走命令台账（幂等、If-Match revision 409），首次执行与幂等重放都按当前功能权限、按钮与范围复核，响应按当前字段裁剪。
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
  reviewContext,
  reviewScope,
  requireFilterVisible,
  reviewWriteContext,
  TALENT_REVIEW_BASE,
  trimReview,
  type TalentReviewContext,
} from './access.js';
import { readinessCreate, readinessPatch } from './readiness-input.js';
import * as readiness from './readiness-service.js';

const PATH = `${TALENT_REVIEW_BASE}/readiness-levels`;

export function registerTalentReviewRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(PATH, async (c) => {
    const ctx = await reviewContext(c, deps, 'readiness');
    const page = pageQuery(c);
    const enabled = booleanQuery(c, 'enabled');
    // 筛选字段同样受字段查看权约束：看不到 enabled 的人不能用筛选还原启用状态（第 2 轮 P2-01）
    if (enabled !== undefined) await requireFilterVisible(deps, ctx, 'readiness', 'enabled');
    const scope = await reviewScope(c, deps, ctx, 'readiness');
    const visible = configScopeSql(scope, 'talent_readiness_levels');
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      readiness.listReadinessViews(tx, ctx.tenantId, { ...page, enabled, visible }),
    );
    return c.json({ ...configEnvelope(page, scope), items: await trimReview(deps, ctx, 'readiness', items) });
  });
  router.get(`${PATH}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'readiness');
    const id = uuidParam(c);
    const scope = await reviewScope(c, deps, ctx, 'readiness');
    const found = await withTenant(deps.db, ctx.tenantId, (tx) => readiness.loadReadinessView(tx, ctx.tenantId, id));
    // 不存在与范围外同一个 404，不泄露对象是否存在
    if (!found) throw new AppError('NOT_FOUND', notFoundMessage('readiness'));
    requireConfigVisible(scope, 'readiness', found.createdBy);
    c.header('ETag', `"${found.revision}"`);
    return c.json((await trimReview(deps, ctx, 'readiness', [found]))[0]);
  });
  router.post(PATH, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'readiness', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, readinessCreate);
    await checkWriteFields(deps, ctx, 'readiness', 'create', body);
    return runWrite(c, deps, ctx, body, 201, (tx, w) => readiness.createReadiness(tx, w, body));
  });
  router.patch(`${PATH}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'readiness', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, readinessPatch);
    await checkWriteFields(deps, ctx, 'readiness', 'update', body);
    return runWrite(c, deps, ctx, body, 200, (tx, w) => readiness.updateReadiness(tx, w, id, body));
  });
  router.delete(`${PATH}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'readiness', 'delete', revision(c));
    const id = uuidParam(c);
    return runWrite(c, deps, ctx, { id }, 200, (tx, w) => readiness.deleteReadiness(tx, w, id));
  });
}

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
  execute: (tx: Tx, ctx: readiness.WriteContext) => Promise<readiness.ReadinessView>,
) {
  const scope = await reviewScope(c, deps, ctx, 'readiness');
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input: body },
    execute: async (tx, commandId) => ({ status, body: await execute(tx, { ...ctx, commandId, scope }) }),
  });
  const view = result.body as readiness.ReadinessView;
  requireConfigVisible(scope, 'readiness', view.createdBy);
  if (c.req.method !== 'DELETE') c.header('ETag', `"${view.revision}"`);
  return c.json((await trimReview(deps, ctx, 'readiness', [view]))[0], result.status);
}
