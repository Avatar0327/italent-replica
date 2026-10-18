/**
 * R2 BE-15b2 自动发起试用期考核规则与立即执行路由（B58；挂在任职子应用 policedSub 上，策略登记在 employment/policy.ts）。
 * 同自动转正规则（auto-regularization-routes.ts，权限、命令内复核、回执裁剪都复用那里的实现）：读 = 任职设置配置对象查看；
 * 写（新增 / 编辑 / 复制 / 启停 / 删除 / 立即执行）= 任职设置配置写（tenant.employment.configuration.write，管理员 other_settings）。
 * 总开关：两层配置 probation.auto_assessment_enabled，经既有 /api/tenant/settings/:key 读写，这里只登记取值校验。
 */
import { withTenant } from '@italent/db';
import { AUTO_ASSESSMENT_SETTING_KEY, isAutoAssessmentSettingValue, MODULE_OBJECTS } from '@italent/domain';
import type { Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { trimModuleResponse } from '../permission/module-access.js';
import { registerSettingValidator } from '../tenant-settings/service.js';
import { runAutoAssessmentNow } from './auto-assessment.js';
import {
  copyAutoAssessmentRule,
  deleteAutoAssessmentRule,
  listAutoAssessmentRules,
  parseAutoAssessmentRule,
  saveAutoAssessmentRule,
  setAutoAssessmentRuleEnabled,
} from './auto-assessment-rules.js';
import { parseRuleEnabled } from './auto-regularization-rules.js';
import { parseRunBody, ruleGuard, visibleRunReceipt, writeContext } from './auto-regularization-routes.js';
import { jsonBody, readContext, requireEmploymentWrite, runWrite, uuidParam } from './context.js';

registerSettingValidator(AUTO_ASSESSMENT_SETTING_KEY, isAutoAssessmentSettingValue);

const SETTINGS = MODULE_OBJECTS.employmentSettings.code;

export function registerAutoAssessmentRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/auto-assessment-rules', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentSettings');
    const rules = await withTenant(deps.db, ctx.tenantId, (tx) => listAutoAssessmentRules(tx, ctx.tenantId));
    return c.json({ items: await trimModuleResponse(deps, ctx, SETTINGS, rules) });
  });
  router.post('/auto-assessment-rules', async (c) => {
    const ctx = await writeContext(c, deps);
    const input = parseAutoAssessmentRule(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'create', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, context) => ({ status: 201, body: await saveAutoAssessmentRule(tx, context, input) }),
      { guard: ruleGuard(deps, ctx, input, 'create') },
    );
  });
  router.put('/auto-assessment-rules/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await writeContext(c, deps);
    const input = parseAutoAssessmentRule(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      { id, input },
      async (tx, context) => ({ status: 200, body: await saveAutoAssessmentRule(tx, context, input, id) }),
      { guard: ruleGuard(deps, ctx, input) },
    );
  });
  registerRuleRowActions(router, deps);
  registerRunNow(router, deps);
}

/** 行操作：复制（If-Match 0，另建一条，默认停用）、单条启停（DEC-533②）、删除；配置对象没有删除操作，删除沿用 update。 */
function registerRuleRowActions(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/auto-assessment-rules/:id/copy', async (c) => {
    const id = uuidParam(c);
    const ctx = await writeContext(c, deps);
    await requireEmploymentWrite(ctx, 'create', {}, undefined, 'TenantBase.EmploymentSettings', { commandOnly: true });
    return runWrite(
      c,
      deps,
      ctx,
      { id, action: 'copy' },
      async (tx, context) => ({ status: 201, body: await copyAutoAssessmentRule(tx, context, id) }),
      { guard: ruleGuard(deps, ctx, {}, 'create') },
    );
  });
  router.put('/auto-assessment-rules/:id/enabled', async (c) => {
    const id = uuidParam(c);
    const ctx = await writeContext(c, deps);
    const enabled = parseRuleEnabled(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', { enabled }, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      { id, enabled },
      async (tx, context) => ({ status: 200, body: await setAutoAssessmentRuleEnabled(tx, context, id, enabled) }),
      { guard: ruleGuard(deps, ctx, { enabled }) },
    );
  });
  router.delete('/auto-assessment-rules/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await writeContext(c, deps);
    await requireEmploymentWrite(ctx, 'update', {}, undefined, 'TenantBase.EmploymentSettings', { commandOnly: true });
    return runWrite(
      c,
      deps,
      ctx,
      { id },
      async (tx, context) => ({ status: 200, body: await deleteAutoAssessmentRule(tx, context, id) }),
      { guard: ruleGuard(deps, ctx, {}), project: (body) => body },
    );
  });
}

/**
 * 立即执行（DEC-539①）：body 严格 { cursor? }；按启用规则扫描并发起。回执逐人列出发起 / 失败（员工、规则、考核、原因）
 * 和续跑句柄 nextCursor，不含任职字段值；回执按操作人当前的任职查看权与数据范围裁剪（首次与同键重放同一出口）。
 */
function registerRunNow(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/auto-assessment/run', async (c) => {
    const ctx = await writeContext(c, deps);
    const { cursor } = parseRunBody(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', {}, undefined, 'TenantBase.EmploymentSettings', { commandOnly: true });
    return runWrite(
      c,
      deps,
      ctx,
      { action: 'auto-assessment-run', cursor },
      async (tx, context) => ({ status: 200, body: await runAutoAssessmentNow(tx, context, cursor) }),
      { guard: ruleGuard(deps, ctx, {}), project: (body) => visibleRunReceipt(deps, ctx, body) },
    );
  });
}
