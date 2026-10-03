/**
 * 审批中心路由（R1-T07）：/api/tenant/approval/*。写请求带 If-Match 与 Idempotency-Key，业务 + 审计 + outbox 同事务；
 * 字段权限与数据范围在事务外解析（授权器自带事务），命令内只做有界读写。
 */
import { pgErrorCode, type Tx, withTenant } from '@italent/db';
import { APPROVAL_PROCESS_OBJECT, APPROVAL_TYPES } from '@italent/domain';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { runCommand, type CommandResult } from '../../commands.js';
import { handleError } from '../../errors.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { registerEmploymentApprovalHooks } from '../employment/approval-hooks.js';
import { pageQuery, parseBody, revision, uuidParam } from '../job/context.js';
import { getModuleViewableFields, trimModuleResponse } from '../permission/module-access.js';
import { registerPersonnelApprovalHooks } from '../personnel/approval-hooks.js';
import { adminScope, requireProcessButton, requireProcessView, requireWithdrawRight } from './access.js';
import {
  addSign,
  adminAct,
  approveTask,
  cancel,
  editTask,
  rejectTask,
  resubmit,
  transferTask,
  urge,
  withdraw,
  type Outcome,
} from './actions.js';
import { ADAPTERS } from './adapters.js';
import { approvalError, type ApprovalContext } from './context.js';
import { approvalTypeOf, createSchema, definitionSchema, toDefinition } from './definition-input.js';
import {
  createProcess,
  discardProcess,
  installPresets,
  listProcesses,
  loadProcess,
  newVersion,
  publishProcess,
  replaceDraft,
} from './definitions.js';
import { detailView, readDetail } from './disclosure.js';
import { startOrResume } from './engine.js';
import { handoverExceptionAdmin } from './handover.js';
import { listAdminLogs, listInstances, listNotifications, listTodos } from './queries.js';
import { simulateByObject, simulateProcess } from './simulation.js';
import { activeInstanceOf, instanceOfTask, loadInstance } from './store.js';

type C = Context<TenantEnv>;

function readCtx(c: C, deps: TenantRouteDeps): ApprovalContext {
  return { ...tenantOf(c), now: deps.clock(), commandId: '', expectedRevision: 0 };
}

function writeCtx(c: C, deps: TenantRouteDeps): ApprovalContext {
  return { ...readCtx(c, deps), expectedRevision: revision(c) };
}

/** 锁冲突（死锁、序列化失败、锁超时）返回可识别的 409，由客户端刷新后显式重提，不自动盲重试（清单 11）。 */
const LOCK_CONFLICTS = new Set(['40P01', '40001', '55P03']);

async function command(
  c: C,
  deps: TenantRouteDeps,
  ctx: ApprovalContext,
  input: unknown,
  execute: (tx: Tx, ctx: ApprovalContext) => Promise<CommandResult>,
) {
  try {
    return await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input },
      execute: (tx, commandId) => execute(tx, { ...ctx, commandId }),
    });
  } catch (error) {
    if (LOCK_CONFLICTS.has(pgErrorCode(error) ?? '')) {
      throw approvalError('CONFLICT', 'APPROVAL_CONCURRENT_CONFLICT', '单据正被他人处理，请刷新后重试');
    }
    throw error;
  }
}

async function respondDetail(c: C, deps: TenantRouteDeps, instanceId: string) {
  const ctx = readCtx(c, deps);
  const scope = await adminScope(deps, ctx, ['adminTransfer', 'adminIntervene']);
  const data = await withTenant(deps.db, ctx.tenantId, (tx) =>
    readDetail(tx, ctx, instanceId, { userId: ctx.userId, adminScope: scope }),
  );
  const viewable = await getModuleViewableFields(deps, ctx, data.snapshot.fieldObjectCode);
  return c.json(detailView(data, ctx.userId, viewable));
}

async function respondOutcome(c: C, deps: TenantRouteDeps, result: CommandResult) {
  if (result.status !== 200) return c.json(result.body as object, result.status);
  return respondDetail(c, deps, (result.body as { instanceId: string }).instanceId);
}

async function processResponse(c: C, deps: TenantRouteDeps, result: CommandResult) {
  const body = await trimModuleResponse(deps, tenantOf(c), APPROVAL_PROCESS_OBJECT, result.body as object);
  return c.json(body, result.status);
}

export const registerApprovalRoutes: TenantRouteModule = (router, deps) => {
  registerHooks();
  const module = new Hono<TenantEnv>();
  module.onError(handleError);
  registerProcessRoutes(module, deps);
  registerSimulationRoutes(module, deps);
  registerReadRoutes(module, deps);
  registerTaskRoutes(module, deps);
  registerInstanceRoutes(module, deps);
  router.route('/api/tenant/approval', module);
};

/** 把审批中心装配到任职与人员模块的挂接端口（它们不 import 审批模块）。 */
function registerHooks() {
  registerEmploymentApprovalHooks({
    submitted: async (tx, ctx, businessId) => {
      await startOrResume(tx, ctx, { businessType: 'employment', businessId });
    },
    withdrawn: async (tx, ctx, businessId) => {
      const active = await activeInstanceOf(tx, ctx.tenantId, 'employment', businessId);
      if (active) await withdraw(tx, ctx, active.id, true);
    },
    deleted: async (tx, ctx, businessId) => {
      const active = await activeInstanceOf(tx, ctx.tenantId, 'employment', businessId);
      if (active) await cancel(tx, ctx, active.id);
    },
  });
  registerPersonnelApprovalHooks({
    submitted: async (tx, ctx, requestId) => {
      await startOrResume(tx, ctx, { businessType: 'personnel_change', businessId: requestId });
    },
  });
}

function registerProcessRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/types', async (c) => {
    await requireProcessView(deps, tenantOf(c));
    return c.json({ items: Object.values(APPROVAL_TYPES) });
  });
  router.get('/processes', async (c) => {
    const ctx = readCtx(c, deps);
    await requireProcessView(deps, ctx);
    const status = z
      .enum(['active', 'discarded'])
      .catch('active')
      .parse(c.req.query('status') ?? 'active');
    const approvalType = c.req.query('approvalType');
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listProcesses(tx, ctx.tenantId, { status, ...(approvalType ? { approvalType } : {}) }, page),
    );
    return c.json({ items: await trimModuleResponse(deps, ctx, APPROVAL_PROCESS_OBJECT, items), page: page.page });
  });
  router.get('/processes/:id', async (c) => {
    const ctx = readCtx(c, deps);
    await requireProcessView(deps, ctx);
    const view = await withTenant(deps.db, ctx.tenantId, (tx) => loadProcess(tx, ctx.tenantId, uuidParam(c)));
    return c.json(await trimModuleResponse(deps, ctx, APPROVAL_PROCESS_OBJECT, view));
  });
  router.post('/processes', async (c) => {
    const ctx = writeCtx(c, deps);
    const input = await parseBody(c, createSchema);
    await requireProcessButton(deps, ctx, 'create', input);
    const type = approvalTypeOf(input.approvalType);
    const definition = toDefinition(input, type);
    const result = await command(c, deps, ctx, input, async (tx, context) => ({
      status: 201,
      body: await createProcess(tx, context, { code: input.code, approvalType: type }, definition),
    }));
    return processResponse(c, deps, result);
  });
  router.put('/processes/:id/draft', async (c) => {
    const ctx = writeCtx(c, deps);
    const id = uuidParam(c);
    const input = await parseBody(c, definitionSchema);
    await requireProcessButton(deps, ctx, 'update', input);
    const result = await command(c, deps, ctx, input, async (tx, context) => {
      const definition = toDefinition(input, (await loadProcess(tx, context.tenantId, id)).approvalType);
      return { status: 200, body: await replaceDraft(tx, context, id, definition) };
    });
    return processResponse(c, deps, result);
  });
  const lifecycle = [
    ['versions', 'newVersion', newVersion, 201],
    ['publish', 'publish', publishProcess, 200],
    ['discard', 'discard', discardProcess, 200],
  ] as const;
  for (const [path, button, run, status] of lifecycle) {
    router.post(`/processes/:id/${path}`, async (c) => {
      const ctx = writeCtx(c, deps);
      const id = uuidParam(c);
      await requireProcessButton(deps, ctx, button);
      const result = await command(c, deps, ctx, { id }, async (tx, context) => ({
        status,
        body: await run(tx, context, id),
      }));
      return processResponse(c, deps, result);
    });
  }
  router.post('/exception-admins/handover', async (c) => {
    const ctx = writeCtx(c, deps);
    const input = await parseBody(c, z.strictObject({ fromUserId: z.uuid(), toUserId: z.uuid() }));
    await requireProcessButton(deps, ctx, 'publish');
    const result = await command(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await handoverExceptionAdmin(tx, context, input),
    }));
    return c.json(result.body as object, result.status);
  });
  router.post('/presets/install', async (c) => {
    const ctx = writeCtx(c, deps);
    await requireProcessButton(deps, ctx, 'installPresets');
    const result = await command(c, deps, ctx, {}, async (tx, context) => ({
      status: 200,
      body: { items: await installPresets(tx, context) },
    }));
    return processResponse(c, deps, result);
  });
}

const simulationData = z.strictObject({
  values: z.record(z.string().max(100), z.union([z.string().max(500), z.null()])),
  subjectEmployeeId: z.uuid().nullable().optional(),
  initiatorUserId: z.uuid().nullable().optional(),
});
const scope = z.enum(['published', 'latest']).default('published');

function registerSimulationRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/processes/:id/simulate', async (c) => {
    const ctx = readCtx(c, deps);
    const id = uuidParam(c);
    const input = await parseBody(c, z.strictObject({ scope, data: simulationData }));
    await requireProcessButton(deps, ctx, 'simulate');
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => simulateProcess(tx, ctx, id, input)));
  });
  router.post('/simulate', async (c) => {
    const ctx = readCtx(c, deps);
    const input = await parseBody(c, z.strictObject({ approvalType: z.string(), scope, data: simulationData }));
    await requireProcessButton(deps, ctx, 'simulateByObject');
    const request = { ...input, approvalType: approvalTypeOf(input.approvalType) };
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => simulateByObject(tx, ctx, request)));
  });
}

function registerReadRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/todos', async (c) => {
    const ctx = readCtx(c, deps);
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listTodos(tx, ctx.tenantId, ctx.userId, page));
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
  router.get('/notifications', async (c) => {
    const ctx = readCtx(c, deps);
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listNotifications(tx, ctx.tenantId, ctx.userId, page),
    );
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
  router.get('/instances', async (c) => {
    const ctx = readCtx(c, deps);
    const page = pageQuery(c);
    const role = z.enum(['initiated', 'participated']).parse(c.req.query('role') ?? 'initiated');
    const businessId = c.req.query('businessId');
    if (businessId !== undefined) z.uuid().parse(businessId);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listInstances(tx, ctx.tenantId, ctx.userId, { role, ...(businessId ? { businessId } : {}) }, page),
    );
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
  router.get('/instances/:id', (c) => respondDetail(c, deps, uuidParam(c)));
  router.get('/admin-logs', async (c) => {
    const ctx = readCtx(c, deps);
    const scopeSql = await adminScope(deps, ctx, ['adminLogs']);
    if (!scopeSql) throw approvalError('FORBIDDEN', 'APPROVAL_ADMIN_REQUIRED', '无权查看流程管理日志');
    const flag = c.req.query('adminSelfTransfer');
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listAdminLogs(tx, ctx.tenantId, scopeSql, flag === undefined ? {} : { adminSelfTransfer: flag === 'true' }, page),
    );
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
}

/** 盲审与编辑都按查看人对业务对象的可查看字段判断；对象由业务快照决定（人员子集各有对象）。 */
async function viewableFor(c: C, deps: TenantRouteDeps, taskId: string) {
  const ctx = readCtx(c, deps);
  const objectCode = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    const instance = await loadInstance(tx, ctx.tenantId, await instanceOfTask(tx, ctx.tenantId, taskId));
    const snapshot = await ADAPTERS[instance.businessType].snapshot(tx, ctx, instance.businessId);
    return snapshot.fieldObjectCode;
  });
  return getModuleViewableFields(deps, ctx, objectCode);
}

const comment = z.string().trim().max(2000).nullable().optional();
const fields = z.record(z.string().max(100), z.unknown());

function registerTaskRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const decision = z.strictObject({ comment, fields: fields.optional() });
  for (const [path, act] of [
    ['approve', approveTask],
    ['reject', rejectTask],
  ] as const) {
    router.post(`/tasks/:id/${path}`, async (c) => {
      const ctx = writeCtx(c, deps);
      const taskId = uuidParam(c);
      const input = await parseBody(c, decision);
      const viewable = await viewableFor(c, deps, taskId);
      const request = { taskId, comment: input.comment ?? null, ...(input.fields ? { fields: input.fields } : {}) };
      const result = await command(c, deps, ctx, request, (tx, context) => act(tx, context, request, viewable));
      return respondOutcome(c, deps, result);
    });
  }
  const delegateSchema = (key: 'toUserId' | 'userId') => z.strictObject({ [key]: z.uuid(), comment });
  for (const [path, key, act] of [
    ['transfer', 'toUserId', transferTask],
    ['add-sign', 'userId', addSign],
  ] as const) {
    router.post(`/tasks/:id/${path}`, async (c) => {
      const ctx = writeCtx(c, deps);
      const input = (await parseBody(c, delegateSchema(key))) as Record<string, string | null | undefined>;
      const request = { taskId: uuidParam(c), userId: input[key]!, comment: input.comment ?? null };
      const result = await command(c, deps, ctx, request, (tx, context) => act(tx, context, request));
      return respondOutcome(c, deps, result);
    });
  }
  router.post('/tasks/:id/edit', async (c) => {
    const ctx = writeCtx(c, deps);
    const taskId = uuidParam(c);
    const input = await parseBody(c, z.strictObject({ fields }));
    const viewable = await viewableFor(c, deps, taskId);
    const request = { taskId, fields: input.fields };
    const result = await command(c, deps, ctx, request, (tx, context) => editTask(tx, context, request, viewable));
    return respondOutcome(c, deps, result);
  });
}

const adminBody = z.strictObject({
  kind: z.enum(['reassign', 'jump']).optional(),
  taskId: z.uuid().optional(),
  toUserId: z.uuid().optional(),
  toNodeKey: z.string().max(40).optional(),
  reason: z.string().trim().max(500).nullable().optional(),
});

function registerInstanceRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const own: readonly [string, (tx: Tx, ctx: ApprovalContext, id: string) => Promise<Outcome>][] = [
    ['urge', urge],
    ['withdraw', withdraw],
    ['resubmit', resubmit],
  ];
  for (const [path, act] of own) {
    router.post(`/instances/:id/${path}`, async (c) => {
      const ctx = writeCtx(c, deps);
      const id = uuidParam(c);
      if (path === 'withdraw') await requireWithdrawRight(deps, ctx, id);
      const result = await command(c, deps, ctx, { id }, (tx, context) => act(tx, context, id));
      return respondOutcome(c, deps, result);
    });
  }
  for (const path of ['admin-transfer', 'admin-intervene'] as const) {
    router.post(`/instances/:id/${path}`, async (c) => {
      const ctx = writeCtx(c, deps);
      const instanceId = uuidParam(c);
      const body = await parseBody(c, adminBody);
      const scopeSql = await adminScope(deps, ctx, [path === 'admin-transfer' ? 'adminTransfer' : 'adminIntervene']);
      if (!scopeSql) throw approvalError('FORBIDDEN', 'APPROVAL_ADMIN_REQUIRED', '无权转交或干预流程');
      const kind = path === 'admin-transfer' ? 'transfer' : (body.kind ?? 'reassign');
      if (kind !== 'jump' && (!body.taskId || !body.toUserId)) {
        throw approvalError('VALIDATION_FAILED', 'APPROVAL_TARGET_REQUIRED', '必须指定任务与新审批人');
      }
      const input = {
        instanceId,
        kind,
        reason: body.reason ?? null,
        ...(body.taskId ? { taskId: body.taskId } : {}),
        ...(body.toUserId ? { toUserId: body.toUserId } : {}),
        ...(body.toNodeKey ? { toNodeKey: body.toNodeKey } : {}),
      } as const;
      const result = await command(c, deps, ctx, input, (tx, context) => adminAct(tx, context, input, scopeSql));
      return respondOutcome(c, deps, result);
    });
  }
}
