/**
 * 审批中心路由（R1-T07）：/api/tenant/approval/*。写请求带 If-Match 与 Idempotency-Key，业务 + 审计 + outbox 同事务；
 * 字段权限与数据范围在事务外解析（授权器自带事务），命令内只做有界读写。
 */
import { pgErrorCode, registerMembershipRevokeHook, type Tx, withTenant } from '@italent/db';
import {
  ADD_SIGN_TYPES,
  APPROVAL_PROCESS_OBJECT,
  APPROVAL_TYPES,
  APPROVER_EXPRESSIONS,
  MAX_ADD_SIGNERS,
  PERSONNEL_OBJECT,
} from '@italent/domain';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { runCommand, type CommandResult } from '../../commands.js';
import { handleError } from '../../errors.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import { tenantOf, type TenantContext, type TenantEnv } from '../../tenant-context.js';
import { registerEmploymentApprovalHooks } from '../employment/approval-hooks.js';
import { pageQuery, parseBody, revision, uuidParam as rawUuidParam } from '../job/context.js';
import {
  getModuleViewableFields,
  getModuleViewableFieldsInTransaction,
  trimModuleResponse,
} from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { registerPersonnelApprovalHooks } from '../personnel/approval-hooks.js';
import {
  adminScope,
  isProcessAdmin,
  requireProcessButton,
  requireProcessView,
  requireResubmitRight,
  requireWithdrawRight,
} from './access.js';
import {
  addSign,
  adminAct,
  approveTask,
  cancel,
  disagreeTask,
  editTask,
  rejectTask,
  resubmit,
  transferTask,
  urge,
  withdraw,
  type Outcome,
} from './actions.js';
import { ADAPTERS } from './adapters.js';
import { approvalError, canonicalId, type ApprovalContext, type FieldAccess } from './context.js';
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
import {
  detailView,
  disclosedFields,
  projectLog,
  readDetail,
  recordsHidden,
  visibleTasks,
  type DetailData,
  type Viewer,
} from './disclosure.js';
import { copySend, retrieveTask } from './node-actions.js';
import { startOrResume } from './engine.js';
import { discloseHandover, handoverExceptionAdmin, takeOverOnDeactivation, type HandoverResult } from './handover.js';
import { listAdminLogs, listInstances, listNotifications, listTodos } from './queries.js';
import { simulateByObject, simulateProcess } from './simulation.js';
import {
  activeInstanceOf,
  instanceOfTask,
  loadInstance,
  pageLogs,
  pageTasks,
  type LogView,
  type TaskRow,
} from './store.js';

type C = Context<TenantEnv>;

/** 按授权器解析任意用户对业务对象的可查看字段（同人自动跳过前的盲审要看候选审批人的权限，清单 5）。 */
function fieldAccess(deps: TenantRouteDeps, ctx: TenantContext): FieldAccess {
  return {
    viewable: (tx, userId, objectCode) =>
      getModuleViewableFieldsInTransaction(deps, { ...ctx, userId }, objectCode, tx),
  };
}

/** 本模块的租户上下文：租户与用户 ID 按数据库 UUID 语义规范化（context.canonicalId，P2-1）。 */
function tenantCtx(c: C): TenantContext {
  const tenant = tenantOf(c);
  return { ...tenant, tenantId: canonicalId(tenant.tenantId), userId: canonicalId(tenant.userId) };
}

/** 请求体里的用户 ID：同样按数据库 UUID 语义规范化。 */
const userIdInput = z.uuid().transform(canonicalId);

/** 路径里的实例 / 任务 / 流程 ID 同样规范化（与库里取出的 ID 按字符串比较时不因大小写错位）。 */
function uuidParam(c: C, name?: string): string {
  return canonicalId(rawUuidParam(c, name));
}

function readCtx(c: C, deps: TenantRouteDeps): ApprovalContext {
  const tenant = tenantCtx(c);
  return { ...tenant, now: deps.clock(), commandId: '', expectedRevision: 0, fields: fieldAccess(deps, tenant) };
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

/** 查看人的两个管理员按钮各自的实例范围（第四轮 N8：详情逐按钮公布动作）。 */
async function viewerOf(deps: TenantRouteDeps, ctx: TenantContext): Promise<Viewer> {
  return {
    userId: ctx.userId,
    transferScope: await adminScope(deps, ctx, ['adminTransfer']),
    interveneScope: await adminScope(deps, ctx, ['adminIntervene']),
  };
}

/**
 * 详情可见字段：业务对象的字段查看权，加上表单带出的员工档案只读字段按员工信息对象的查看权（DEC-122）。
 * undefined = 不受字段权限约束。
 */
async function detailViewable(deps: TenantRouteDeps, ctx: TenantContext, data: DetailData) {
  const base = await getModuleViewableFields(deps, ctx, data.snapshot.fieldObjectCode);
  const profileFields = data.snapshot.profileFields;
  if (!profileFields.length) return base;
  const profile = await getModuleViewableFields(deps, ctx, PERSONNEL_OBJECT);
  if (base === undefined && profile === undefined) return undefined;
  const own = base ?? new Set(Object.keys(data.snapshot.values).filter((field) => !profileFields.includes(field)));
  return new Set([...own, ...profileFields.filter((field) => profile === undefined || profile.has(field))]);
}

async function respondDetail(c: C, deps: TenantRouteDeps, instanceId: string) {
  const ctx = readCtx(c, deps);
  const viewer = await viewerOf(deps, ctx);
  const data = await withTenant(deps.db, ctx.tenantId, (tx) => readDetail(tx, ctx, instanceId, viewer));
  return c.json(detailView(data, ctx.userId, await detailViewable(deps, ctx, data)));
}

/** DEC-101 / X-19：完整任务与日志历史分页读取（最新在前），权限与披露同详情。 */
async function respondHistory(c: C, deps: TenantRouteDeps, kind: 'tasks' | 'logs') {
  const ctx = readCtx(c, deps);
  const instanceId = uuidParam(c);
  const page = pageQuery(c);
  const viewer = await viewerOf(deps, ctx);
  const { data, rows } = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    const detail = await readDetail(tx, ctx, instanceId, viewer);
    const items =
      kind === 'tasks'
        ? await pageTasks(tx, ctx.tenantId, instanceId, page)
        : await pageLogs(tx, ctx.tenantId, instanceId, page);
    return { data: detail, rows: items };
  });
  const viewable = await detailViewable(deps, ctx, data);
  // DEC-104 / DEC-115：查看人参与的任一节点（或开始节点）勾选了审批记录查看权限时，历史同样隐藏，只留当前待办。
  const hidden = recordsHidden(data, ctx.userId);
  const disclosed = disclosedFields(data, ctx.userId, viewable);
  const items =
    kind === 'tasks'
      ? visibleTasks(data, ctx.userId, rows as TaskRow[])
      : hidden
        ? []
        : (rows as LogView[]).map((log) => projectLog(log, disclosed));
  return c.json({ items, recordsHidden: hidden, page: page.page, pageSize: page.pageSize });
}

async function respondOutcome(c: C, deps: TenantRouteDeps, result: CommandResult) {
  if (result.status !== 200) return c.json(result.body as object, result.status);
  return respondDetail(c, deps, (result.body as { instanceId: string }).instanceId);
}

/** 流程管理员看完整配置（DEC-102）；其余可查看者按流程对象字段权限裁剪。 */
async function trimProcess<T extends object>(deps: TenantRouteDeps, ctx: TenantContext, value: T | T[]) {
  if (await isProcessAdmin(deps, ctx)) return value;
  return trimModuleResponse(deps, ctx, APPROVAL_PROCESS_OBJECT, value as object);
}

async function processResponse(c: C, deps: TenantRouteDeps, result: CommandResult) {
  return c.json(await trimProcess(deps, tenantCtx(c), result.body as object), result.status);
}

export const registerApprovalRoutes: TenantRouteModule = (router, deps) => {
  registerHooks(deps);
  const module = new Hono<TenantEnv>();
  module.onError(handleError);
  registerProcessRoutes(module, deps);
  registerTenantConfigRoutes(module, deps);
  registerSimulationRoutes(module, deps);
  registerReadRoutes(module, deps);
  registerTaskRoutes(module, deps);
  registerInstanceRoutes(module, deps);
  router.route('/api/tenant/approval', module);
};

/** 把审批中心装配到任职与人员模块的挂接端口（它们不 import 审批模块）。 */
function registerHooks(deps: TenantRouteDeps) {
  const withFields = <T extends ApprovalContext>(ctx: T): T => ({ ...ctx, fields: fieldAccess(deps, ctx) });
  // DEC-123：成员停用（平台撤销成员关系）的同一事务内，自动转派其剩余在途异常待办。
  registerMembershipRevokeHook((tx, revocation) => takeOverOnDeactivation(tx, deps, revocation));
  registerEmploymentApprovalHooks({
    submitted: async (tx, ctx, businessId) => {
      await startOrResume(tx, withFields(ctx), { businessType: 'employment', businessId });
    },
    withdrawn: async (tx, ctx, businessId) => {
      const active = await activeInstanceOf(tx, ctx.tenantId, 'employment', businessId);
      if (active) await withdraw(tx, withFields(ctx), active.id, true);
    },
    deleted: async (tx, ctx, businessId) => {
      const active = await activeInstanceOf(tx, ctx.tenantId, 'employment', businessId);
      if (active) await cancel(tx, withFields(ctx), active.id);
    },
  });
  registerPersonnelApprovalHooks({
    submitted: async (tx, ctx, requestId) => {
      await startOrResume(tx, withFields(ctx), { businessType: 'personnel_change', businessId: requestId });
    },
  });
}

function registerProcessRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/types', async (c) => {
    await requireProcessView(deps, tenantCtx(c));
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
    return c.json({ items: await trimProcess(deps, ctx, items), page: page.page });
  });
  router.get('/processes/:id', async (c) => {
    const ctx = readCtx(c, deps);
    await requireProcessView(deps, ctx);
    const view = await withTenant(deps.db, ctx.tenantId, (tx) => loadProcess(tx, ctx.tenantId, uuidParam(c)));
    return c.json(await trimProcess(deps, ctx, view));
  });
  router.post('/processes', async (c) => {
    const ctx = writeCtx(c, deps);
    const input = await parseBody(c, createSchema);
    await requireProcessButton(deps, ctx, 'create');
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
    await requireProcessButton(deps, ctx, 'update');
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
}

/** 租户级配置动作：异常管理员交接（DEC-098）与出厂预置安装（DEC-018 / DEC-094）。 */
function registerTenantConfigRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/exception-admins/handover', async (c) => {
    const ctx = writeCtx(c, deps);
    const input = await parseBody(
      c,
      z.strictObject({ fromUserId: userIdInput, toUserId: userIdInput, cursor: z.uuid().nullable().optional() }),
    );
    // F2：替换流程配置要求流程配置权（DEC-102）；改派在途实例另按实例转交按钮 + 数据范围逐单判断。
    await requireProcessButton(deps, ctx, 'publish');
    const scopeSql = await adminScope(deps, ctx, ['adminTransfer']);
    const handover = {
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    };
    const result = await command(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await handoverExceptionAdmin(tx, context, handover, scopeSql),
    }));
    // R4-1：幂等重放返回台账里的首次结果，其中的实例编号按调用者当前的范围重新裁剪（不重新执行交接）。
    const body = await withTenant(deps.db, ctx.tenantId, (tx) =>
      discloseHandover(tx, ctx, result.body as HandoverResult, scopeSql),
    );
    return c.json(body, result.status);
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

/** 仿真只收虚拟数据（清单 7）：审批人关系、直线经理、组织上下级都由输入给出，不接受真实员工标识去查库。 */
const simulationData = z.strictObject({
  values: z.record(z.string().max(100), z.union([z.string().max(500), z.null()])),
  relations: z.partialRecord(z.enum(APPROVER_EXPRESSIONS), userIdInput.nullable()).optional(),
  managers: z
    .record(z.uuid(), userIdInput.nullable())
    .transform((managers) =>
      Object.fromEntries(Object.entries(managers).map(([userId, manager]) => [canonicalId(userId), manager])),
    )
    .optional(),
  orgAncestors: z.record(z.uuid(), z.array(z.uuid()).max(100)).optional(),
  initiatorUserId: userIdInput.nullable().optional(),
  subjectUserId: userIdInput.nullable().optional(),
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
  router.get('/instances/:id/tasks', (c) => respondHistory(c, deps, 'tasks'));
  router.get('/instances/:id/logs', (c) => respondHistory(c, deps, 'logs'));
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

/** 任务所属业务对象（人员子集各有对象）：盲审与编辑都按查看人对该对象的字段权限判断。 */
async function objectOfTask(c: C, deps: TenantRouteDeps, taskId: string) {
  const ctx = readCtx(c, deps);
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const instance = await loadInstance(tx, ctx.tenantId, await instanceOfTask(tx, ctx.tenantId, taskId));
    return (await ADAPTERS[instance.businessType].snapshot(tx, ctx, instance.businessId)).fieldObjectCode;
  });
}

/**
 * 可查看字段 + 编辑权（清单 2）：带编辑内容时，编辑字段须是审批人当前可编辑的字段且对象编辑操作开启；
 * 审批身份不能把只读字段变成可写（节点可编辑字段在命令内再取交集）。
 */
async function fieldRights(c: C, deps: TenantRouteDeps, taskId: string, edits: Record<string, unknown> | undefined) {
  const ctx = readCtx(c, deps);
  const objectCode = await objectOfTask(c, deps, taskId);
  if (edits && Object.keys(edits).length)
    await requireObjectWrite(deps.authorize, ctx, { objectCode, operation: 'update', payload: edits });
  return getModuleViewableFields(deps, ctx, objectCode);
}

const comment = z.string().trim().max(2000).nullable().optional();
const fields = z.record(z.string().max(100), z.unknown());

function registerTaskRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const decision = z.strictObject({ comment, fields: fields.optional() });
  for (const [path, act] of [
    ['approve', approveTask],
    ['disagree', disagreeTask],
    ['reject', rejectTask],
  ] as const) {
    router.post(`/tasks/:id/${path}`, async (c) => {
      const ctx = writeCtx(c, deps);
      const taskId = uuidParam(c);
      const input = await parseBody(c, decision);
      const viewable = await fieldRights(c, deps, taskId, input.fields);
      const request = { taskId, comment: input.comment ?? null, ...(input.fields ? { fields: input.fields } : {}) };
      const result = await command(c, deps, ctx, request, (tx, context) => act(tx, context, request, viewable));
      return respondOutcome(c, deps, result);
    });
  }
  router.post('/tasks/:id/transfer', async (c) => {
    const ctx = writeCtx(c, deps);
    const input = await parseBody(c, z.strictObject({ toUserId: userIdInput, comment }));
    const request = { taskId: uuidParam(c), userId: input.toUserId, comment: input.comment ?? null };
    const result = await command(c, deps, ctx, request, (tx, context) => transferTask(tx, context, request));
    return respondOutcome(c, deps, result);
  });
  router.post('/tasks/:id/add-sign', async (c) => {
    const ctx = writeCtx(c, deps);
    const taskId = uuidParam(c);
    const signers = z.array(userIdInput).min(1).max(MAX_ADD_SIGNERS);
    const input = await parseBody(c, z.strictObject({ userIds: signers, type: z.enum(ADD_SIGN_TYPES), comment }));
    // 后加签含本人的同意，盲审按本人字段权限判断（DEC-095）。
    const viewable = await fieldRights(c, deps, taskId, undefined);
    const request = { taskId, userIds: input.userIds, type: input.type, comment: input.comment ?? null };
    const result = await command(c, deps, ctx, request, (tx, context) => addSign(tx, context, request, viewable));
    return respondOutcome(c, deps, result);
  });
  router.post('/tasks/:id/cc', async (c) => {
    const ctx = writeCtx(c, deps);
    const input = await parseBody(c, z.strictObject({ userIds: z.array(userIdInput).min(1).max(20), comment }));
    const request = { taskId: uuidParam(c), userIds: input.userIds, comment: input.comment ?? null };
    const result = await command(c, deps, ctx, request, (tx, context) => copySend(tx, context, request));
    return respondOutcome(c, deps, result);
  });
  router.post('/tasks/:id/retrieve', async (c) => {
    const ctx = writeCtx(c, deps);
    const taskId = uuidParam(c);
    const result = await command(c, deps, ctx, { taskId }, (tx, context) => retrieveTask(tx, context, taskId));
    return respondOutcome(c, deps, result);
  });
  router.post('/tasks/:id/edit', async (c) => {
    const ctx = writeCtx(c, deps);
    const taskId = uuidParam(c);
    const input = await parseBody(c, z.strictObject({ fields }));
    const viewable = await fieldRights(c, deps, taskId, input.fields);
    const request = { taskId, fields: input.fields };
    const result = await command(c, deps, ctx, request, (tx, context) => editTask(tx, context, request, viewable));
    return respondOutcome(c, deps, result);
  });
}

const adminBody = z.strictObject({
  kind: z.enum(['reassign', 'jump']).optional(),
  taskId: z.uuid().optional(),
  toUserId: userIdInput.optional(),
  toNodeKey: z.string().max(40).optional(),
  reason: z.string().trim().max(500).nullable().optional(),
});

function registerInstanceRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const own: readonly [string, (tx: Tx, ctx: ApprovalContext, id: string) => Promise<Outcome>][] = [
    ['urge', urge],
    ['withdraw', withdraw],
  ];
  router.post('/instances/:id/resubmit', async (c) => {
    const ctx = writeCtx(c, deps);
    const id = uuidParam(c);
    // DEC-099：员工信息变更可带修正内容在同一张单上重提。
    const input = c.req.header('content-type') ? await parseBody(c, z.strictObject({ fields: fields.optional() })) : {};
    // DEC-113 / F3：只有原发起人能重提，并按首次提交复核其当前的自助权限与本人绑定。
    await requireResubmitRight(deps, ctx, id);
    const result = await command(c, deps, ctx, { id, input }, (tx, context) => resubmit(tx, context, id, input.fields));
    return respondOutcome(c, deps, result);
  });
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
