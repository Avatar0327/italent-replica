/**
 * R2 BE-15a 自动转正规则与立即执行路由（B57；挂在任职子应用 policedSub 上，策略登记在 employment/policy.ts）。
 * 同自动加黑规则：读 = 任职设置配置对象查看；写（新增 / 编辑 / 复制 / 启停 / 删除 / 立即执行）= 任职设置配置写
 * （tenant.employment.configuration.write，管理员 other_settings），命令内经 CommandGuard.before 按当前授权再过一遍（#199）。
 * 总开关：两层配置 probation.auto_regularization_enabled，经既有 /api/tenant/settings/:key 读写，这里只登记取值校验。
 */
import { isUuid, withTenant } from '@italent/db';
import {
  AUTO_REGULARIZATION_SETTING_KEY,
  isAutoRegularizationSettingValue,
  MODULE_OBJECTS,
  tenantLocalDate,
} from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import type { CommandGuard } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction, resolveModuleScope, trimModuleResponse } from '../permission/module-access.js';
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
  EMPLOYMENT_OBJECT,
  jsonBody,
  readContext,
  requireEmployeeInScope,
  requireEmploymentWrite,
  revision,
  runWrite,
  uuidParam,
  type EmploymentContext,
} from './context.js';

registerSettingValidator(AUTO_REGULARIZATION_SETTING_KEY, isAutoRegularizationSettingValue);

const SETTINGS = MODULE_OBJECTS.employmentSettings.code;

/** 规则写入与立即执行的命令内复核：配置写别名（other_settings）与配置对象字段编辑权，同入口。 */
export function ruleGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  payload: Readonly<Record<string, unknown>>,
  operation: 'create' | 'update' = 'update',
): CommandGuard {
  return {
    before: async (tx) => {
      const authorize = authorizeInTransaction(deps.authorize, tx);
      await requirePermission(authorize, {
        ...ctx,
        action: 'tenant.employment.configuration.write',
        resource: SETTINGS,
      });
      await requireObjectWrite(authorize, ctx, { objectCode: SETTINGS, operation, payload });
    },
  };
}

/** 规则写入与立即执行的入口上下文：配置写别名 + If-Match（同自动加黑规则）。 */
export function writeContext(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  return readContext(
    c,
    deps,
    'tenant.employment.configuration.write',
    revision(c),
    undefined,
    'TenantBase.EmploymentSettings',
  );
}

export function registerAutoRegularizationRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/auto-regularization-rules', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentSettings');
    const rules = await withTenant(deps.db, ctx.tenantId, (tx) => listAutoRegularizationRules(tx, ctx.tenantId));
    return c.json({ items: await trimModuleResponse(deps, ctx, SETTINGS, rules) });
  });
  router.post('/auto-regularization-rules', async (c) => {
    const ctx = await writeContext(c, deps);
    const input = parseAutoRegularizationRule(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'create', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, context) => ({ status: 201, body: await saveAutoRegularizationRule(tx, context, input) }),
      { guard: ruleGuard(deps, ctx, input, 'create') },
    );
  });
  router.put('/auto-regularization-rules/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await writeContext(c, deps);
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
  registerRuleRowActions(router, deps);
  registerRunNow(router, deps);
}

/** 行操作：复制（If-Match 0，另建一条）、单条启停（DEC-533②）、删除；配置对象没有删除操作，删除沿用 update。 */
function registerRuleRowActions(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/auto-regularization-rules/:id/copy', async (c) => {
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
      async (tx, context) => ({ status: 201, body: await copyAutoRegularizationRule(tx, context, id) }),
      { guard: ruleGuard(deps, ctx, {}, 'create') },
    );
  });
  router.put('/auto-regularization-rules/:id/enabled', async (c) => {
    const id = uuidParam(c);
    const ctx = await writeContext(c, deps);
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
    const ctx = await writeContext(c, deps);
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
 * 立即执行（DEC-539①）：body 严格 { cursor? }；按启用规则扫描并发起。回执逐人列出发起 / 失败（员工、规则、业务、原因）
 * 和续跑游标 nextCursor，不含任职字段值。权限同规则维护。
 */
function registerRunNow(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/auto-regularization/run', async (c) => {
    const ctx = await writeContext(c, deps);
    const { cursor } = parseRunBody(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', {}, undefined, 'TenantBase.EmploymentSettings', {
      commandOnly: true,
    });
    return runWrite(
      c,
      deps,
      ctx,
      { action: 'auto-regularization-run', cursor },
      async (tx, context) => ({ status: 200, body: await runAutoRegularizationNow(tx, context, cursor) }),
      // 首次与同键重放都经这里按操作人当前的任职范围裁剪（第 2 轮审查 P1）
      { guard: ruleGuard(deps, ctx, {}), project: (body) => visibleRunReceipt(deps, ctx, body) },
    );
  });
}

/** body 严格 { cursor? }：cursor 为上一次回执的 nextCursor（续跑句柄，随机 UUID），从它记下的位置之后接着扫描。 */
export function parseRunBody(raw: unknown): { readonly cursor: string | null } {
  const parsed = z.strictObject({ cursor: z.string().refine(isUuid, '续跑游标须为 UUID').optional() }).safeParse(raw);
  if (!parsed.success)
    throw new AppError('VALIDATION_FAILED', '立即执行的请求体须为 {} 或 { cursor }', parsed.error.issues);
  return { cursor: parsed.data.cursor?.toLowerCase() ?? null };
}

/**
 * 回执按操作人“当前”权限裁剪（第 2 轮审查 P1）：系统批次按规则的适用组织办理（不算越权写入），但回执里的员工、业务、
 * 发起人只列操作人有任职记录查看权且在其数据范围内的员工；没有查看权或范围为空时两列都为空。重放同样在这里按当前权限
 * 重新裁剪，撤权后拿不到原回执里的人。续跑句柄（nextCursor）不含员工信息，原样返回。
 */
export async function visibleRunReceipt(deps: TenantRouteDeps, ctx: EmploymentContext, body: unknown) {
  // 自动转正与自动考核（BE-15b2）的立即执行回执同形：launched / failed 都按 employeeId 逐人过滤
  const receipt = body as {
    readonly launched: readonly { readonly employeeId: string }[];
    readonly failed: readonly { readonly employeeId: string }[];
  };
  const ids = [...new Set([...receipt.launched, ...receipt.failed].map((item) => item.employeeId))];
  const visible = await visibleEmployees(deps, ctx, ids);
  return {
    ...receipt,
    launched: receipt.launched.filter((item) => visible.has(item.employeeId)),
    failed: receipt.failed.filter((item) => visible.has(item.employeeId)),
  };
}

async function visibleEmployees(deps: TenantRouteDeps, ctx: EmploymentContext, ids: readonly string[]) {
  const visible = new Set<string>();
  if (!ids.length) return visible;
  const tenant = { tenantId: ctx.tenantId, userId: ctx.userId, timezone: ctx.timezone };
  if (!(await deps.authorize({ ...tenant, action: 'object.view', resource: EMPLOYMENT_OBJECT }))) return visible;
  const now = deps.clock();
  const scope = await resolveModuleScope(deps, tenant, tenantLocalDate(now, ctx.timezone), EMPLOYMENT_OBJECT);
  const reader: EmploymentContext = { ...ctx, now, scope, objectCode: EMPLOYMENT_OBJECT };
  await withTenant(deps.db, ctx.tenantId, async (tx) => {
    for (const id of ids)
      try {
        await requireEmployeeInScope(tx, reader, id);
        visible.add(id);
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'NOT_FOUND')) throw error;
      }
  });
  return visible;
}
