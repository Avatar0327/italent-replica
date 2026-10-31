/**
 * R2 BE-8b1 离职交接设置路由（B64 交接事项、B65 交接发起规则；挂在任职子应用 policedSub 上，策略登记在 employment/policy.ts）。
 * - 交接事项：任职设置配置对象（tenant.employment.configuration.write，管理员 other_settings），同自动加黑规则页。
 * - 交接发起规则：两层配置 exit.handover_trigger，经既有 /api/tenant/settings/:key 读写，这里只登记取值校验：
 *   F-250 / DEC-683 接入其余发起方式，发起人规则仍只接受员工本人。
 */
import { checkHandoverTrigger, EXIT_HANDOVER_TRIGGER_KEY, MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import { withTenant, type Tx } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { runCommand, type CommandGuard } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction, trimModuleResponse } from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { registerSettingValidator } from '../tenant-settings/service.js';
import {
  commandContext,
  jsonBody,
  readContext,
  readPageContext,
  requireEmploymentWrite,
  revision,
  runWrite,
  uuidParam,
  type EmploymentContext,
} from './context.js';
import { businessKind } from './exit-gate.js';
import { exitHandoverStatus, handoverDetail, isHandoverParticipant, tickHandoverItem } from './exit-handover.js';
import { deleteHandoverItem, listHandoverItems, parseHandoverItem, saveHandoverItem } from './exit-handover-items.js';
import { loadHandoverRequest } from './exit-handover-store.js';
import { handoverSubmitGuard, requireHandoverSubmit, submitExitHandover } from './exit-handover-launch.js';
import { handoverResubmitGuard, requireHandoverResubmit, resubmitExitHandover } from './exit-handover-resubmit.js';
import { registerHandoverListRoutes } from './exit-handover-list-routes.js';
import { loadEmploymentBusiness } from './read-model.js';

// 校验函数本身可以抛：未验证的取值给出明确提示，其余取值返回 false 走通用的“配置值不合法”
registerSettingValidator(EXIT_HANDOVER_TRIGGER_KEY, (value) => {
  const checked = checkHandoverTrigger(value);
  if (!checked.ok && checked.unverified)
    throw new AppError('VALIDATION_FAILED', '该交接发起人未验证、后补，当前只支持发起人为员工本人', {
      reason: 'HANDOVER_TRIGGER_UNVERIFIED',
      key: EXIT_HANDOVER_TRIGGER_KEY,
    });
  return checked.ok;
});

const SETTINGS = MODULE_OBJECTS.employmentSettings.code;
const tickBody = z.strictObject({ done: z.boolean() });

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
  registerHandoverExecutionRoutes(router, deps);
}

/**
 * 交接执行的三个入口（BE-8b2）：
 * - GET /exits/:id/handover：离职详情上的交接状态与事项（未发起 / 进行中 / 已完成 / 已终止），权限与范围同离职详情（DEC-177）；
 * - GET /exit-handover-requests/:id：交接申请详情，参与人（员工本人 / 在该审批实例上有任务的审批人）可读，editable 标出当前可办理的事项；
 * - PUT /exit-handover-requests/:id/items/:itemId：勾选“办理完成”自动保存，只认当前待办办理人与其节点负责的类别。
 * 后两个不要求任职对象权限（审批人不一定有），身份由参与关系与待办决定，范围外与不存在同一个 404。
 */
function registerHandoverSubmitRoute(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/exits/:id/handover/submit', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    await withTenant(deps.db, ctx.tenantId, (tx) => requireHandoverSubmit(tx, ctx, id));
    if (!z.strictObject({}).safeParse(await jsonBody(c)).success)
      throw new AppError('VALIDATION_FAILED', '发起交接只接受空请求体');
    const result = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input: {} },
      guard: handoverSubmitGuard(deps, ctx, id),
      execute: async (tx, commandId) => ({
        status: 200,
        body: await submitExitHandover(tx, { ...(await commandContext(tx, deps, ctx)), commandId }, id),
      }),
    });
    c.header('ETag', `"${(result.body as { revision: number }).revision}"`);
    return c.json(result.body, result.status);
  });
}

function registerHandoverExecutionRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerHandoverSubmitRoute(router, deps);
  registerHandoverListRoutes(router, deps);
  // DEC-674：详情级重新提交，If-Match 为交接 revision；空命令体，不复用编辑离职按钮。
  router.post('/exit-handover-requests/:id/resubmit', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    await withTenant(deps.db, ctx.tenantId, (tx) => requireHandoverResubmit(tx, ctx, id));
    if (!z.strictObject({}).safeParse(await jsonBody(c)).success)
      throw new AppError('VALIDATION_FAILED', '重新提交交接只接受空请求体');
    const result = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input: {} },
      guard: handoverResubmitGuard(deps, ctx, id),
      execute: async (tx, commandId) => ({
        status: 200,
        body: await resubmitExitHandover(tx, { ...(await commandContext(tx, deps, ctx)), commandId }, id),
      }),
    });
    c.header('ETag', `"${(result.body as { revision: number }).revision}"`);
    return c.json(result.body, result.status);
  });
  router.get('/exits/:id/handover', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'detail');
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const found = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const business = await loadEmploymentBusiness(tx, ctx.tenantId, id, today, ctx.scope);
      if (!business || (await businessKind(tx, ctx.tenantId, id)) !== 'leave') return null;
      return { employeeId: business.employeeId, view: await exitHandoverStatus(tx, ctx.tenantId, id) };
    });
    if (!found) throw new AppError('NOT_FOUND', '任职业务不存在');
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: found.employeeId });
    return c.json(found.view);
  });
  router.get('/exit-handover-requests/:id', async (c) => {
    const id = uuidParam(c);
    const tenant = tenantOf(c);
    const detail = await withTenant(deps.db, tenant.tenantId, async (tx) => {
      const row = await loadHandoverRequest(tx, tenant.tenantId, id);
      if (!(await isHandoverParticipant(tx, tenant.tenantId, row, tenant.userId)))
        throw new AppError('NOT_FOUND', '离职交接申请不存在');
      return handoverDetail(tx, tenant.tenantId, row, tenant.userId);
    });
    return c.json(detail);
  });
  router.put('/exit-handover-requests/:id/items/:itemId', async (c) => {
    const id = uuidParam(c);
    const itemId = uuidParam(c, 'itemId');
    const tenant = tenantOf(c);
    const input = tickBody.safeParse(await jsonBody(c));
    if (!input.success) throw new AppError('VALIDATION_FAILED', '请求体只接受 { done: boolean }', input.error.issues);
    const ctx = { ...tenant, now: deps.clock(), expectedRevision: revision(c), commandId: '' };
    const guard: CommandGuard = {
      before: async (tx: Tx) => {
        const row = await loadHandoverRequest(tx, tenant.tenantId, id);
        if (!(await isHandoverParticipant(tx, tenant.tenantId, row, tenant.userId)))
          throw new AppError('NOT_FOUND', '离职交接申请不存在');
      },
    };
    const result = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input: input.data },
      guard,
      execute: async (tx, commandId) => ({
        status: 200,
        body: await tickHandoverItem(tx, { ...ctx, commandId }, id, itemId, input.data.done),
      }),
    });
    return c.json(result.body, result.status);
  });
}
