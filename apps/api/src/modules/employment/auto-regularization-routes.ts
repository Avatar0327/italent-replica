/**
 * R2 BE-15a 自动转正规则与立即执行路由（B57；挂在任职子应用 policedSub 上，策略登记在 employment/policy.ts）。
 * 同自动加黑规则：读 = 任职设置配置对象查看；写（新增 / 编辑 / 复制 / 启停 / 删除 / 立即执行）= 任职设置配置写
 * （tenant.employment.configuration.write，管理员 other_settings），命令内经 CommandGuard.before 按当前授权再过一遍（#199）。
 * 总开关：两层配置 probation.auto_regularization_enabled，经既有 /api/tenant/settings/:key 读写，这里只登记取值校验。
 */
import { withTenant } from '@italent/db';
import { AUTO_REGULARIZATION_SETTING_KEY, isAutoRegularizationSettingValue, MODULE_OBJECTS } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { requirePermission } from '../../authorization.js';
import type { CommandGuard } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction, trimModuleResponse } from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { registerSettingValidator } from '../tenant-settings/service.js';
import { runAutoRegularizationNow } from './auto-regularization.js';
import {
  copyAutoRegularizationRule,
  deleteAutoRegularizationRule,
  listAutoRegularizationRules,
  parseAutoRegularizationRule,
  parseRuleEnabled,
  saveAutoRegularizationRule,
  setAutoRegularizationRuleEnabled,
} from './auto-regularization-rules.js';
import {
  jsonBody,
  readContext,
  requireEmploymentWrite,
  revision,
  runWrite,
  uuidParam,
  type EmploymentContext,
} from './context.js';

registerSettingValidator(AUTO_REGULARIZATION_SETTING_KEY, isAutoRegularizationSettingValue);

const SETTINGS = MODULE_OBJECTS.employmentSettings.code;

/** 规则写入与立即执行的命令内复核：配置写别名（other_settings）与配置对象字段编辑权，同入口。 */
function ruleGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  payload: Readonly<Record<string, unknown>>,
): CommandGuard {
  return {
    before: async (tx) => {
      const authorize = authorizeInTransaction(deps.authorize, tx);
      await requirePermission(authorize, {
        ...ctx,
        action: 'tenant.employment.configuration.write',
        resource: SETTINGS,
      });
      await requireObjectWrite(authorize, ctx, { objectCode: SETTINGS, operation: 'update', payload });
    },
  };
}

export function registerAutoRegularizationRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const configuration = (c: Context<TenantEnv>) =>
    readContext(
      c,
      deps,
      'tenant.employment.configuration.write',
      revision(c),
      undefined,
      'TenantBase.EmploymentSettings',
    );
  router.get('/auto-regularization-rules', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentSettings');
    const rules = await withTenant(deps.db, ctx.tenantId, (tx) => listAutoRegularizationRules(tx, ctx.tenantId));
    return c.json({ items: await trimModuleResponse(deps, ctx, SETTINGS, rules) });
  });
  router.post('/auto-regularization-rules', async (c) => {
    const ctx = await configuration(c);
    const input = parseAutoRegularizationRule(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'create', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, context) => ({ status: 201, body: await saveAutoRegularizationRule(tx, context, input) }),
      { guard: ruleGuard(deps, ctx, input) },
    );
  });
  router.put('/auto-regularization-rules/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await configuration(c);
    const input = parseAutoRegularizationRule(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      { id, input },
      async (tx, context) => ({ status: 200, body: await saveAutoRegularizationRule(tx, context, input, id) }),
      { guard: ruleGuard(deps, ctx, input) },
    );
  });
  registerRuleRowActions(router, deps, configuration);
  registerRunNow(router, deps, configuration);
}

type Configuration = (c: Context<TenantEnv>) => Promise<EmploymentContext>;

/** 行操作：复制（If-Match 0，另建一条）、单条启停（DEC-533②）、删除；配置对象没有删除操作，删除沿用 update。 */
function registerRuleRowActions(router: Hono<TenantEnv>, deps: TenantRouteDeps, configuration: Configuration) {
  router.post('/auto-regularization-rules/:id/copy', async (c) => {
    const id = uuidParam(c);
    const ctx = await configuration(c);
    await requireEmploymentWrite(ctx, 'create', {}, undefined, 'TenantBase.EmploymentSettings', {
      commandOnly: true,
    });
    return runWrite(
      c,
      deps,
      ctx,
      { id, action: 'copy' },
      async (tx, context) => ({ status: 201, body: await copyAutoRegularizationRule(tx, context, id) }),
      { guard: ruleGuard(deps, ctx, {}) },
    );
  });
  router.put('/auto-regularization-rules/:id/enabled', async (c) => {
    const id = uuidParam(c);
    const ctx = await configuration(c);
    const enabled = parseRuleEnabled(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', { enabled }, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      { id, enabled },
      async (tx, context) => ({
        status: 200,
        body: await setAutoRegularizationRuleEnabled(tx, context, id, enabled),
      }),
      { guard: ruleGuard(deps, ctx, { enabled }) },
    );
  });
  router.delete('/auto-regularization-rules/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await configuration(c);
    await requireEmploymentWrite(ctx, 'update', {}, undefined, 'TenantBase.EmploymentSettings', {
      commandOnly: true,
    });
    return runWrite(
      c,
      deps,
      ctx,
      { id },
      async (tx, context) => ({ status: 200, body: await deleteAutoRegularizationRule(tx, context, id) }),
      { guard: ruleGuard(deps, ctx, {}), project: (body) => body },
    );
  });
}

/**
 * 立即执行（DEC-539①）：body 严格 {}；按启用规则扫描并发起，回执逐人列出发起 / 失败（员工、规则、业务、原因），
 * 不含任职字段值。权限同规则维护。
 */
function registerRunNow(router: Hono<TenantEnv>, deps: TenantRouteDeps, configuration: Configuration) {
  router.post('/auto-regularization/run', async (c) => {
    const ctx = await configuration(c);
    parseRunBody(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', {}, undefined, 'TenantBase.EmploymentSettings', {
      commandOnly: true,
    });
    return runWrite(
      c,
      deps,
      ctx,
      { action: 'auto-regularization-run' },
      async (tx, context) => ({ status: 200, body: await runAutoRegularizationNow(tx, context) }),
      { guard: ruleGuard(deps, ctx, {}), project: (body) => body },
    );
  });
}

function parseRunBody(raw: unknown): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length)
    throw new AppError('VALIDATION_FAILED', '立即执行的请求体须为 {}');
}
