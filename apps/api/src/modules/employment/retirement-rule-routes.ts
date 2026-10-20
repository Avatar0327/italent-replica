/**
 * R2 BE-5c1a 预计退休日期规则与个人身份字典路由（R2-T04 §9.1 / §12.1；挂在任职子应用 policedSub 上，策略登记在
 * employment/policy.ts）。读 = 任职记录查看权（object.view，F-269）；写（新增 / 编辑 / 复制 / 启停 / 删除）= 任职设置配置写
 * （tenant.employment.configuration.write），命令内经 CommandGuard.before 按当前授权再过一遍（#199）。
 * 个人身份字典只读（DEC-640③）：读取对持任职记录查看权者开放（人事表单下拉），没有 POST / PUT。
 * 三个配置项（自动计算预计日期 / 弹性范围开关、即将退休天数）走既有 /api/tenant/settings/:key，这里只登记取值校验。
 */
import { withTenant } from '@italent/db';
import {
  isRetirementSwitchValue,
  isRetirementUpcomingDays,
  RETIREMENT_AUTO_EXPECTED_DATE_KEY,
  RETIREMENT_AUTO_FLEXIBLE_RANGE_KEY,
  RETIREMENT_UPCOMING_DAYS_KEY,
} from '@italent/domain';
import type { Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { listRetirementIdentityTypes } from '../personnel/identity-types.js';
import { registerSettingValidator } from '../tenant-settings/service.js';
import { ruleGuard, visibleEmployees, writeContext } from './auto-regularization-routes.js';
import { jsonBody, readContext, requireEmploymentWrite, runWrite, uuidParam } from './context.js';
import {
  copyRetirementRule,
  deleteRetirementRule,
  listRetirementRules,
  parseRetirementRule,
  parseRuleEnabled,
  parseRulePurpose,
  saveRetirementRule,
  setRetirementRuleEnabled,
} from './retirement-rules.js';
import {
  parseRetirementRunBody,
  parseRunPurpose,
  runRetirementRulesNow,
  type RetirementRunReceipt,
} from './retirement-run.js';
import type { EmploymentContext } from './types.js';

registerSettingValidator(RETIREMENT_AUTO_EXPECTED_DATE_KEY, isRetirementSwitchValue);
registerSettingValidator(RETIREMENT_AUTO_FLEXIBLE_RANGE_KEY, isRetirementSwitchValue);
registerSettingValidator(RETIREMENT_UPCOMING_DAYS_KEY, isRetirementUpcomingDays);

export function registerRetirementRuleRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/retirement-rules', async (c) => {
    // F-269：读 = 任职记录查看权（设计 §12.1），与字典读取同口径；规则是租户配置，无字段裁剪、不叠加数据范围
    const ctx = await readContext(c, deps, 'object.view', 0);
    const purpose = parseRulePurpose(c.req.query('purpose'));
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listRetirementRules(tx, ctx.tenantId, purpose));
    return c.json({ items });
  });
  router.post('/retirement-rules', async (c) => {
    const ctx = await writeContext(c, deps);
    const input = parseRetirementRule(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'create', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, context) => ({ status: 201, body: await saveRetirementRule(tx, context, input) }),
      { guard: ruleGuard(deps, ctx, input, 'create') },
    );
  });
  router.put('/retirement-rules/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await writeContext(c, deps);
    const input = parseRetirementRule(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      { id, input },
      async (tx, context) => ({ status: 200, body: await saveRetirementRule(tx, context, input, id) }),
      { guard: ruleGuard(deps, ctx, input) },
    );
  });
  registerRuleRowActions(router, deps);
  registerRunNow(router, deps);
  router.get('/retirement-identity-types', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listRetirementIdentityTypes(tx, ctx.tenantId));
    return c.json({ items });
  });
}

/** 行操作：复制（If-Match 0，另建一条）、单条启停、删除；配置对象没有删除操作，删除沿用 update。 */
function registerRuleRowActions(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/retirement-rules/:id/copy', async (c) => {
    const id = uuidParam(c);
    const ctx = await writeContext(c, deps);
    await requireEmploymentWrite(ctx, 'create', {}, undefined, 'TenantBase.EmploymentSettings', {
      commandOnly: true,
    });
    return runWrite(
      c,
      deps,
      ctx,
      { id, action: 'copy' },
      async (tx, context) => ({ status: 201, body: await copyRetirementRule(tx, context, id) }),
      { guard: ruleGuard(deps, ctx, {}, 'create') },
    );
  });
  router.put('/retirement-rules/:id/enabled', async (c) => {
    const id = uuidParam(c);
    const ctx = await writeContext(c, deps);
    const enabled = parseRuleEnabled(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', { enabled }, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      { id, enabled },
      async (tx, context) => ({ status: 200, body: await setRetirementRuleEnabled(tx, context, id, enabled) }),
      { guard: ruleGuard(deps, ctx, { enabled }) },
    );
  });
  router.delete('/retirement-rules/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await writeContext(c, deps);
    await requireEmploymentWrite(ctx, 'update', {}, undefined, 'TenantBase.EmploymentSettings', {
      commandOnly: true,
    });
    return runWrite(
      c,
      deps,
      ctx,
      { id },
      async (tx, context) => ({ status: 200, body: await deleteRetirementRule(tx, context, id) }),
      { guard: ruleGuard(deps, ctx, {}), project: (body) => body },
    );
  });
}

/**
 * 立即执行（R2-T04 §9.2）：POST /retirement-rules/run?purpose=，body 严格 { cursor? }。权限同规则维护；
 * 回执按操作人当前的任职范围逐人裁剪（首次与同键重放同一出口），续跑句柄不含员工信息，原样返回。
 */
function registerRunNow(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/retirement-rules/run', async (c) => {
    const ctx = await writeContext(c, deps);
    const purpose = parseRunPurpose(c.req.query('purpose'));
    const { cursor } = parseRetirementRunBody(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', {}, undefined, 'TenantBase.EmploymentSettings', {
      commandOnly: true,
    });
    return runWrite(
      c,
      deps,
      ctx,
      { action: 'retirement-rule-run', purpose, cursor },
      async (tx, context) => ({ status: 200, body: await runRetirementRulesNow(tx, context, purpose, cursor) }),
      { guard: ruleGuard(deps, ctx, {}), project: (body) => visibleRetirementReceipt(deps, ctx, body) },
    );
  });
}

async function visibleRetirementReceipt(deps: TenantRouteDeps, ctx: EmploymentContext, body: unknown) {
  const receipt = body as RetirementRunReceipt;
  const ids = [...new Set([...receipt.updated, ...receipt.failed].map((item) => item.employeeId))];
  const visible = await visibleEmployees(deps, ctx, ids);
  return {
    ...receipt,
    updated: receipt.updated.filter((item) => visible.has(item.employeeId)),
    failed: receipt.failed.filter((item) => visible.has(item.employeeId)),
  };
}
