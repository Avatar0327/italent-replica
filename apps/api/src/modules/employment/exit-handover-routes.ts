/**
 * R2 BE-8b1 离职交接设置路由（B64 交接事项、B65 交接发起规则；挂在任职子应用 policedSub 上，策略登记在 employment/policy.ts）。
 * - 交接事项：任职设置配置对象（tenant.employment.configuration.write，管理员 other_settings），同自动加黑规则页。
 * - 交接发起规则：两层配置 exit.handover_trigger，经既有 /api/tenant/settings/:key 读写，这里只登记取值校验：
 *   未验证的发起方式 / 发起人返回 400 并提示“未验证、后补”（DEC-632）。
 */
import { checkHandoverTrigger, EXIT_HANDOVER_TRIGGER_KEY, MODULE_OBJECTS } from '@italent/domain';
import { withTenant, type Tx } from '@italent/db';
import type { Hono } from 'hono';
import { requirePermission } from '../../authorization.js';
import type { CommandGuard } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction, trimModuleResponse } from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { registerSettingValidator } from '../tenant-settings/service.js';
import {
  jsonBody,
  readContext,
  requireEmploymentWrite,
  revision,
  runWrite,
  uuidParam,
  type EmploymentContext,
} from './context.js';
import { deleteHandoverItem, listHandoverItems, parseHandoverItem, saveHandoverItem } from './exit-handover-items.js';

// 校验函数本身可以抛：未验证的取值给出明确提示，其余取值返回 false 走通用的“配置值不合法”
registerSettingValidator(EXIT_HANDOVER_TRIGGER_KEY, (value) => {
  const checked = checkHandoverTrigger(value);
  if (!checked.ok && checked.unverified)
    throw new AppError(
      'VALIDATION_FAILED',
      '该交接发起方式或发起人未验证、后补，当前只支持审批通过后自动发起、发起人为员工本人',
      {
        reason: 'HANDOVER_TRIGGER_UNVERIFIED',
        key: EXIT_HANDOVER_TRIGGER_KEY,
      },
    );
  return checked.ok;
});

const SETTINGS = MODULE_OBJECTS.employmentSettings.code;

/** 写入的命令内复核：配置写别名（other_settings）与配置对象字段编辑权，同入口（#199）。 */
function itemGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  payload: Readonly<Record<string, unknown>>,
): CommandGuard {
  return {
    before: async (tx: Tx) => {
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

export function registerExitHandoverRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const configuration = (c: Parameters<typeof revision>[0]) =>
    readContext(
      c,
      deps,
      'tenant.employment.configuration.write',
      revision(c),
      undefined,
      'TenantBase.EmploymentSettings',
    );
  router.get('/exit-handover-items', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentSettings');
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listHandoverItems(tx, ctx.tenantId));
    return c.json({ items: await trimModuleResponse(deps, ctx, SETTINGS, items) });
  });
  router.post('/exit-handover-items', async (c) => {
    const ctx = await configuration(c);
    const input = parseHandoverItem(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'create', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, context) => ({ status: 201, body: await saveHandoverItem(tx, context, input) }),
      { guard: itemGuard(deps, ctx, input) },
    );
  });
  router.put('/exit-handover-items/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await configuration(c);
    const input = parseHandoverItem(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      { id, input },
      async (tx, context) => ({ status: 200, body: await saveHandoverItem(tx, context, input, id) }),
      { guard: itemGuard(deps, ctx, input) },
    );
  });
  // 配置对象没有“删除”数据操作，删除沿用 update（同自动加黑规则）
  router.delete('/exit-handover-items/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await configuration(c);
    await requireEmploymentWrite(ctx, 'update', {}, undefined, 'TenantBase.EmploymentSettings', { commandOnly: true });
    return runWrite(
      c,
      deps,
      ctx,
      { id },
      async (tx, context) => ({ status: 200, body: await deleteHandoverItem(tx, context, id) }),
      { guard: itemGuard(deps, ctx, {}), project: (body) => body },
    );
  });
}
