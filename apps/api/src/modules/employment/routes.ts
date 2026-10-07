import { requireEmployeeTransferBusiness } from '../transfer/employee-policy.js';
import { lockImportParticipants } from './forward-import.js';
import { lockTransferParticipants } from './transfer-locks.js';
import { listCompletionTodos } from '../transfer/completion.js';
import { requireTransferButton } from '../transfer/access.js';
import { type Tx, withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { AppError, handleError } from '../../errors.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import { provisionEmployeeUser } from '../permission/user-provisioning.js';
import {
  readSettings,
  updateSettings,
  createCustomField,
  setCustomFieldInheritance,
  listCustomFields,
} from './configuration.js';
import {
  readContext,
  readPageContext,
  jsonBody,
  pageQuery,
  revision,
  queryDate,
  runWrite,
  uuidParam,
  requireEmploymentScope,
  requireEmploymentWrite,
  requireScopedEmploymentObject,
  trimEmploymentResponse,
  EMPLOYEE_OBJECT,
} from './context.js';
import { createEmployee, employeeName, getEmployee, listEmployees } from './employees.js';
import { EmploymentError } from './errors.js';
import { normalizeEmploymentInput, normalizeBusinessPatch } from './fields.js';
import { previewEmploymentEditForwardUpdate, previewEmploymentForwardUpdate } from './forward-preview.js';
import { importEmploymentRecords, normalizeEmploymentImport, previewEmploymentImport } from './forward-import.js';
import { editEmploymentRecord } from './record-edit.js';
import { prepareInheritance, inheritancePreview } from './inheritance.js';
import { lockEmploymentEmployee } from './record-store.js';
import { listEmploymentRecords, loadEmploymentBusiness, loadEmploymentRecord } from './read-model.js';
import {
  createEmploymentBusiness,
  NEW_CYCLE_KINDS,
  requireSavedBusiness,
  updateEmploymentBusiness,
} from './write-service.js';
import { retryActivation } from './activation-service.js';
import { listActivationTodos } from './activation-store.js';
import { transitionEmployment } from './transitions.js';
import {
  disclosePendingApplications,
  PendingApplicationError,
  ReportingCycleDeletionError,
} from './deletion-guards.js';
import { visibleEmploymentRecords } from './visibility.js';
import { employmentApprovalHooks } from './approval-hooks.js';
import type { EmploymentContext } from './types.js';
import { registerTransferRoutes } from '../transfer/routes.js';
import { requireTransferSource } from '../transfer/access.js';
import { requireDirectTransfer, transferBusinessContext } from '../transfer/service.js';
import { batchEditEmploymentRecords, normalizeBatchEdit } from './batch-edit.js';
import { recordOperationLog } from '../../audit/record.js';
import { auditActor } from '../../system-actor.js';
import { rawImportRows, withFailedImportLog } from '../../audit/record.js';
import { failedImportAnchors, importedItems } from './import-audit.js';

export const registerEmploymentRoutes: TenantRouteModule = (router, deps) => {
  const module = new Hono<TenantEnv>();
  module.onError((error, c) => {
    if (error instanceof EmploymentError) {
      return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
    }
    return handleError(error, c);
  });
  registerTransferRoutes(module, deps);
  registerEmployees(module, deps);
  registerEmployeeRecords(module, deps);
  registerInheritancePreview(module, deps);
  registerBusinesses(module, deps);
  registerActivation(module, deps);
  registerForwardUpdates(module, deps);
  registerBatchEdit(module, deps);
  registerSettings(module, deps);
  registerCustomFields(module, deps);
  router.route('/api/tenant/employment', module);
};

/** 登录邮箱不是人员字段：建档 / 入职时交给权限模块的用户端口（DEC-128；入职必填，DEC-140），不参与任职字段权限校验。 */
const loginEmail = z.email().max(320).optional();

function registerEmployees(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/employees', async (c) => {
    const ctx = await readContext(c, deps, 'object.create', revision(c), undefined, EMPLOYEE_OBJECT);
    const input = parse(
      z.strictObject({
        code: z.string().trim().min(1).max(100),
        name: z.string().trim().min(1).max(200),
        loginEmail,
      }),
      await jsonBody(c),
    );
    const profile = { code: input.code, name: input.name };
    await requireEmploymentWrite(ctx, 'create', profile, 'Employee.Create', EMPLOYEE_OBJECT);
    // DEC-121（保持 DEC-081）：新员工尚无任职鉴权字段，仅显式看全部范围可创建；开通预置只覆盖职务、编制方案。
    requireEmploymentScope(ctx);
    return runWrite(c, deps, ctx, input, async (tx, context) => {
      const employee = await createEmployee(tx, context, profile);
      // DEC-128：建档即在同一事务内自动创建并绑定租户用户（AC-PRM-31）
      await provisionEmployeeUser(tx, context, {
        employeeId: employee.id,
        loginEmail: input.loginEmail,
        displayName: employee.name,
      });
      return { status: 201, body: employee };
    });
  });
  router.get('/employees', async (c) => {
    const ctx = await readPageContext(c, deps, 'list', undefined, EMPLOYEE_OBJECT);
    const page = pageQuery(c);
    await requireViewableFilters(deps, ctx, ['employeeStatus', 'entryStatus'], (key) => c.req.query(key));
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listEmployees(
        tx,
        ctx.tenantId,
        queryDate(c, ctx),
        page,
        {
          code: c.req.query('code'),
          name: c.req.query('name'),
          status: parse(z.enum(['pending', 'employed', 'left', 'retired']).optional(), c.req.query('status')),
          // F-022：按当前人员状态 / 入职状态筛选（原站编码）
          employeeStatus: parse(z.coerce.number().int().optional(), c.req.query('employeeStatus')),
          entryStatus: parse(z.coerce.number().int().optional(), c.req.query('entryStatus')),
        },
        ctx.scope,
      ),
    );
    return c.json({
      items: await trimEmploymentResponse(deps, ctx, items),
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope?.hasDataPermission ?? true,
    });
  });
  router.get('/employees/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'detail', id, EMPLOYEE_OBJECT);
    const employee = await withTenant(deps.db, ctx.tenantId, (tx) =>
      getEmployee(tx, ctx.tenantId, id, queryDate(c, ctx), ctx.scope),
    );
    if (!employee) throw new AppError('NOT_FOUND', '员工不存在');
    return c.json(await trimEmploymentResponse(deps, ctx, employee));
  });
  registerEmployeeBusinessCreate(router, deps);
}

function registerEmployeeBusinessCreate(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/employees/:id/businesses', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.create', revision(c), id);
    const { rawInput, email } = splitLoginEmail(await jsonBody(c));
    const input = normalizeEmploymentInput(ctx, rawInput);
    if (email !== undefined && !NEW_CYCLE_KINDS.includes(input.kind)) {
      throw new AppError('VALIDATION_FAILED', '只有入职类业务可以提供登录邮箱');
    }
    await requireEmploymentWrite(ctx, 'create', rawInput as object, 'Employment.Create');
    if (input.kind === 'transfer') {
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        await requireTransferSource(tx, ctx, id, 'hr');
        if (input.mode === 'direct') await requireDirectTransfer(tx, ctx);
      });
    }
    if (input.fields.departmentId !== undefined) requireEmploymentScope(ctx, id, input.fields.departmentId);
    return runWrite(c, deps, ctx, { ...input, loginEmail: email }, async (tx, context) => {
      if (input.kind === 'transfer') {
        await lockTransferParticipants(tx, context, id, input.fields.addedSubordinateIds ?? []);
        await lockEmploymentEmployee(tx, context, id, context.expectedRevision);
        await requireTransferSource(tx, context, id, 'hr');
        if (input.mode === 'direct') await requireDirectTransfer(tx, context);
      }
      const business = await createEmploymentBusiness(tx, context, id, input);
      if (NEW_CYCLE_KINDS.includes(input.kind)) await ensureHiredAccount(tx, context, id, email);
      return { status: 201, body: business };
    });
  });
}

function registerEmployeeRecords(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/employees/:id/records', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'list');
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: id });
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      if (!(await getEmployee(tx, ctx.tenantId, id, queryDate(c, ctx)))) throw new AppError('NOT_FOUND', '员工不存在');
      const rows = await listEmploymentRecords(tx, ctx.tenantId, id, queryDate(c, ctx), page, ctx.scope);
      // DEC-177：没有任何一条对操作人可见的记录时按员工不存在处理，不暴露范围外员工是否存在。
      if (!rows.length && ctx.scope && !ctx.scope.all) {
        const visible =
          page.offset === 0
            ? rows
            : await listEmploymentRecords(tx, ctx.tenantId, id, queryDate(c, ctx), { limit: 1, offset: 0 }, ctx.scope);
        if (!visible.length) throw new AppError('NOT_FOUND', '员工不存在');
      }
      return rows;
    });
    return c.json({
      items: await trimEmploymentResponse(deps, ctx, items),
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope?.hasDataPermission ?? true,
    });
  });
}

function registerInheritancePreview(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/employees/:id/preview', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'detail', id);
    const input = normalizeEmploymentInput(ctx, await jsonBody(c));
    const prepared = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      if (!(await getEmployee(tx, ctx.tenantId, id, queryDate(c, ctx), ctx.scope)))
        throw new AppError('NOT_FOUND', '员工不存在');
      return prepareInheritance(tx, ctx, { ...input, employeeId: id });
    });
    await requirePermission(deps.authorize, {
      ...ctx,
      action: 'object.button',
      resource: 'TenantBase.EmploymentRecord#Employment.Preview@detail',
    });
    requireEmploymentScope(ctx, id, prepared.fields.departmentId);
    return c.json(await trimEmploymentResponse(deps, ctx, inheritancePreview(prepared)));
  });
}

function registerBusinesses(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/businesses/:id', async (c) => {
    const id = uuidParam(c);
    let ctx = await readPageContext(c, deps, 'detail');
    ctx = await withTenant(deps.db, ctx.tenantId, (tx) => transferBusinessContext(tx, ctx, id));
    const value = await withTenant(deps.db, ctx.tenantId, (tx) =>
      loadEmploymentBusiness(tx, ctx.tenantId, id, queryDate(c, ctx), ctx.transferTarget ? undefined : ctx.scope),
    );
    if (!value) throw new AppError('NOT_FOUND', '任职业务不存在');
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: value.employeeId });
    return c.json(await trimEmploymentResponse(deps, ctx, value));
  });
  router.get('/records/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'detail');
    const value = await withTenant(deps.db, ctx.tenantId, (tx) =>
      loadEmploymentRecord(tx, ctx.tenantId, id, queryDate(c, ctx), ctx.scope),
    );
    if (!value) throw new AppError('NOT_FOUND', '任职记录不存在');
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: value.employeeId });
    return c.json(await trimEmploymentResponse(deps, ctx, value));
  });
  router.patch('/businesses/:id', async (c) => {
    const id = uuidParam(c);
    let ctx = await readContext(c, deps, 'object.update', revision(c));
    const input = normalizeBusinessPatch(await jsonBody(c));
    ctx = await withTenant(deps.db, ctx.tenantId, (tx) =>
      transferBusinessContext(tx, ctx, id, 'before-command', input.fields?.departmentId, input),
    );
    const current = await authorizeBusinessWrite(deps, ctx, id);
    await withTenant(deps.db, ctx.tenantId, (tx) => requireEmployeeTransferBusiness(tx, ctx, id, input));
    await requireEmploymentWrite(ctx, 'update', input, 'Employment.Edit');
    const departmentId = input.fields?.departmentId;
    if (departmentId !== undefined && ctx.transferTarget)
      ctx = { ...ctx, transferTarget: { ...ctx.transferTarget, departmentId } };
    if (departmentId !== undefined)
      await withTenant(deps.db, ctx.tenantId, (tx) =>
        requireScopedEmploymentObject(tx, ctx, current.employeeId, departmentId, id),
      );
    return runWrite(c, deps, ctx, input, async (tx, context) => {
      let checked = await transferBusinessContext(
        tx,
        { ...context, transferTarget: undefined },
        id,
        'command',
        departmentId,
        input,
      );
      if (departmentId !== undefined && checked.transferTarget)
        checked = { ...checked, transferTarget: { ...checked.transferTarget, departmentId } };
      return { status: 200, body: await updateEmploymentBusiness(tx, checked, id, input) };
    });
  });
  registerBusinessTransitions(router, deps);
}

function registerBusinessTransitions(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // R1-T11：revoke = HR 撤销未审批完成的申请（置作废、作废流程，AC-TRF-07）；withdraw 是发起人撤回到草稿（AC-TRF-28）。
  for (const action of ['submit', 'withdraw', 'revoke', 'delete'] as const) {
    router.on(
      action === 'delete' ? 'DELETE' : 'POST',
      `/businesses/:id${action === 'delete' ? '' : `/${action}`}`,
      async (c) => {
        const id = uuidParam(c);
        let ctx = await readContext(c, deps, action === 'delete' ? 'object.delete' : 'object.update', revision(c));
        ctx = await withTenant(deps.db, ctx.tenantId, (tx) =>
          transferBusinessContext(tx, ctx, id, 'before-command', undefined, action === 'submit' ? {} : undefined),
        );
        if (action === 'submit') await emptySubmitBody(c);
        await requireEmploymentWrite(
          ctx,
          action === 'delete' ? 'delete' : 'update',
          {},
          `Employment.${action[0]!.toUpperCase()}${action.slice(1)}`,
        );
        await authorizeBusinessWrite(deps, ctx, id);
        if (action === 'submit')
          await withTenant(deps.db, ctx.tenantId, (tx) => requireEmployeeTransferBusiness(tx, ctx, id));
        const write = runWrite(c, deps, ctx, { id, action }, async (tx, context) => {
          const checked = await transferBusinessContext(
            tx,
            { ...context, transferTarget: undefined },
            id,
            'command',
            undefined,
            action === 'submit' ? {} : undefined,
          );
          const business = await transitionEmployment(tx, checked, { id, action });
          // R1-T07：提交即按审批类型匹配流程并发起；撤回 / 撤销 / 删除同步结束在途实例，均与状态迁移同事务。
          if (action === 'submit') await employmentApprovalHooks.submitted(tx, context, id);
          else if (action === 'withdraw') await employmentApprovalHooks.withdrawn(tx, context, id);
          else await employmentApprovalHooks.deleted(tx, context, id);
          return { status: 200, body: business };
        });
        return discloseDeletionBlock(deps, ctx, write);
      },
    );
  }
}

/**
 * 删除拒绝详情按操作人当前范围与字段权限披露（PR #73 第二轮 P2-1、第三轮 3）；不经此处的拒绝默认不带明细：
 * DEC-126 在途申请只给件数；循环汇报只在路径上的人都可见（DEC-177）且经理字段可看时才给完整路径。
 */
async function discloseDeletionBlock<T>(deps: TenantRouteDeps, ctx: EmploymentContext, write: Promise<T>) {
  try {
    return await write;
  } catch (error) {
    if (!(error instanceof PendingApplicationError) && !(error instanceof ReportingCycleDeletionError)) throw error;
    const viewable = await getModuleViewableFields(deps, ctx, 'TenantBase.EmploymentRecord');
    if (error instanceof PendingApplicationError)
      throw await withTenant(deps.db, ctx.tenantId, (tx) => disclosePendingApplications(tx, ctx, error, viewable));
    if (viewable !== undefined && !viewable.has('directManagerId')) throw error;
    const people = error.path.map((employeeId) => ({ employeeId, departmentId: null }));
    const visible = await withTenant(deps.db, ctx.tenantId, (tx) =>
      visibleEmploymentRecords(tx, ctx.tenantId, ctx.scope, people),
    );
    throw visible.every(Boolean) ? error.disclosed : error;
  }
}

/** R1-T08：生效失败待办与 HR 重试（DEC-052 / DEC-112）；定时任务本身只经平台路径运行，租户接口上没有触发入口。 */
function registerActivation(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/completion-todos', async (c) => {
    const ctx = await readPageContext(c, deps, 'list');
    await requireTransferButton(ctx, 'hr');
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listCompletionTodos(tx, ctx, page));
    const viewable = await getModuleViewableFields(deps, ctx, 'TenantBase.EmploymentRecord');
    return c.json({
      items: await Promise.all(
        items.map(async (item) => ({
          ...((await trimEmploymentResponse(deps, ctx, {
            id: item.id,
            employeeId: item.employeeId,
            effectiveDate: item.effectiveDate,
          })) as object),
          fieldCodes: item.fieldCodes.filter(
            (code) => viewable === undefined || viewable.has(code.replace(/^preset:/, '')),
          ),
        })),
      ),
      page: page.page,
      pageSize: page.pageSize,
    });
  });
  router.get('/activation-todos', async (c) => {
    const ctx = await readPageContext(c, deps, 'list');
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listActivationTodos(tx, ctx.tenantId, page, ctx.scope, ctx.timezone),
    );
    return c.json({
      items: await trimEmploymentResponse(deps, ctx, items),
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope?.hasDataPermission ?? true,
    });
  });
  router.post('/businesses/:id/activation/retry', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    await emptySubmitBody(c);
    await requireEmploymentWrite(ctx, 'update', {}, 'Employment.RetryActivation');
    const current = await authorizeBusinessWrite(deps, ctx, id);
    return runWrite(c, deps, ctx, { id, action: 'retry-activation' }, async (tx, context) => {
      await retryActivation(tx, context, id, current.employeeId);
      return { status: 200, body: await requireSavedBusiness(tx, context, id) };
    });
  });
}

/** 提交不接受客户端参数：流程编码由审批中心按业务派生（PR #35 第二轮清单 14），带任何字段一律 400。 */
async function emptySubmitBody(c: Context<TenantEnv>): Promise<void> {
  if (c.req.header('content-type')) parse(z.strictObject({}), await jsonBody(c));
}

function registerBatchEdit(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // R1-T16 / AC-AUD-03：批量编辑任职记录，逐条按单条编辑的权限与范围校验，整单同事务（batch-edit.ts）
  router.post('/records/batch-edit', async (c) => {
    const ctx = await readContext(c, deps, 'object.update');
    const input = normalizeBatchEdit(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', input.patch, 'Employment.Edit');
    const departmentId = input.patch.fields?.departmentId;
    for (const item of input.items) {
      const current = await authorizeBusinessWrite(deps, ctx, item.id);
      if (departmentId !== undefined)
        await withTenant(deps.db, ctx.tenantId, (tx) =>
          requireScopedEmploymentObject(tx, ctx, current.employeeId, departmentId, item.id),
        );
    }
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await batchEditEmploymentRecords(tx, context, input),
    }));
  });
}

async function authorizeBusinessWrite(deps: TenantRouteDeps, ctx: EmploymentContext, id: string, employeeId?: string) {
  // 幂等重放也重验当前范围，不能依赖可能被命令台账跳过的 execute。
  const value = await withTenant(deps.db, ctx.tenantId, (tx) =>
    loadEmploymentBusiness(
      tx,
      ctx.tenantId,
      id,
      tenantLocalDate(ctx.now, ctx.timezone),
      ctx.transferTarget ? undefined : ctx.scope,
      'write',
    ),
  );
  if (!value || (employeeId && value.employeeId !== employeeId)) throw new AppError('NOT_FOUND', '任职业务不存在');
  if (ctx.trustedScopeBypass)
    await requirePermission(deps.authorize, {
      ...ctx,
      action: 'tenant.employment.write',
      resource: value.employeeId,
    });
  return value;
}

function registerSettings(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/settings', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentSettings');
    return c.json(
      await trimEmploymentResponse(
        deps,
        ctx,
        await withTenant(deps.db, ctx.tenantId, (tx) => readSettings(tx, ctx.tenantId)),
      ),
    );
  });
  router.put('/settings', async (c) => {
    const ctx = await readContext(
      c,
      deps,
      'tenant.employment.configuration.write',
      revision(c),
      undefined,
      'TenantBase.EmploymentSettings',
    );
    const input = parse(z.strictObject({ allowDirectTransfer: z.boolean() }), await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await updateSettings(tx, context, input),
    }));
  });
}

function registerCustomFields(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/custom-fields', async (c) => {
    const ctx = await readContext(
      c,
      deps,
      'tenant.employment.configuration.write',
      revision(c),
      undefined,
      'TenantBase.EmploymentCustomField',
    );
    const input = parse(
      z.strictObject({
        name: z.string().trim().min(1).max(200),
        valueType: z.enum(['text', 'integer', 'decimal', 'boolean', 'date']),
        objectType: z.enum(['employment', 'contract']),
      }),
      await jsonBody(c),
    );
    await requireEmploymentWrite(ctx, 'create', input, undefined, 'TenantBase.EmploymentCustomField');
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 201,
      body: await createCustomField(tx, context, input),
    }));
  });
  router.get('/custom-fields', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentCustomField');
    const page = pageQuery(c);
    const objectType = parse(z.enum(['employment', 'contract']).optional(), c.req.query('objectType'));
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listCustomFields(tx, ctx.tenantId, page, objectType));
    return c.json({
      items: await trimEmploymentResponse(deps, ctx, items),
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope?.hasDataPermission ?? true,
    });
  });
  router.put('/custom-fields/:id/inheritance', async (c) => {
    const ctx = await readContext(
      c,
      deps,
      'tenant.employment.configuration.write',
      revision(c),
      undefined,
      'TenantBase.EmploymentCustomField',
    );
    const id = uuidParam(c);
    const input = parse(z.strictObject({ inherit: z.boolean() }), await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentCustomField');
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await setCustomFieldInheritance(tx, context, id, input),
    }));
  });
}

/**
 * DEC-128 / DEC-140：办理入职（含重聘、入职申请）时在同一事务内确保人员已有绑定的租户用户；
 * 尚未绑定又没给登录邮箱即拒绝并提示补填，整单回滚。
 */
async function ensureHiredAccount(tx: Tx, context: EmploymentContext, employeeId: string, loginEmail?: string) {
  const displayName = await employeeName(tx, context.tenantId, employeeId);
  await provisionEmployeeUser(tx, context, { employeeId, loginEmail, displayName, accountRequired: true });
}

/** 入职请求里的登录邮箱与任职业务字段分开：前者交给用户端口，后者照原样校验与鉴权。 */
function splitLoginEmail(body: unknown): { rawInput: unknown; email: string | undefined } {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !('loginEmail' in body)) {
    return { rawInput: body, email: undefined };
  }
  const { loginEmail: raw, ...rest } = body as Record<string, unknown>;
  return { rawInput: rest, email: parse(loginEmail, raw) };
}

/** 不能按不可查看的字段筛选，否则可借筛选结果推断隐藏值（与人员信息列表同一口径）。 */
async function requireViewableFilters(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  keys: readonly string[],
  query: (key: string) => string | undefined,
) {
  const used = keys.filter((key) => query(key) !== undefined);
  if (!used.length) return;
  const viewable = await getModuleViewableFields(deps, ctx, EMPLOYEE_OBJECT);
  if (viewable && used.some((key) => !viewable.has(key))) throw new AppError('FORBIDDEN', '筛选字段不可查看');
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_FAILED', '请求字段不合法', result.error.issues);
  return result.data;
}

function registerForwardUpdates(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/employees/:id/forward-update-preview', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'detail', id);
    const input = normalizeEmploymentInput(ctx, await jsonBody(c));
    await requirePreviewButton(deps, ctx);
    return c.json(
      await trimEmploymentResponse(
        deps,
        ctx,
        await withTenant(deps.db, ctx.tenantId, (tx) => previewEmploymentForwardUpdate(tx, ctx, id, input)),
      ),
    );
  });
  router.post('/records/:id/forward-update-preview', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'detail');
    const input = normalizeBusinessPatch(await jsonBody(c));
    const value = await withTenant(deps.db, ctx.tenantId, (tx) =>
      loadEmploymentBusiness(tx, ctx.tenantId, id, queryDate(c, ctx), ctx.scope),
    );
    if (!value) throw new AppError('NOT_FOUND', '任职业务不存在');
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: value.employeeId });
    await requirePreviewButton(deps, ctx);
    return c.json(
      await trimEmploymentResponse(
        deps,
        ctx,
        await withTenant(deps.db, ctx.tenantId, (tx) => previewEmploymentEditForwardUpdate(tx, ctx, id, input)),
      ),
    );
  });
  router.post('/employees/:id/import/forward-update-preview', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'list', id);
    const input = normalizeEmploymentImport(await jsonBody(c));
    await requirePreviewButton(deps, ctx);
    await authorizeImport(deps, ctx, id, input, true);
    return c.json(
      await trimEmploymentResponse(
        deps,
        ctx,
        await withTenant(deps.db, ctx.tenantId, (tx) => previewEmploymentImport(tx, ctx, id, input)),
      ),
    );
  });
  router.patch('/records/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    const input = normalizeBusinessPatch(await jsonBody(c));
    const current = await authorizeBusinessWrite(deps, ctx, id);
    await requireEmploymentWrite(ctx, 'update', input, 'Employment.Edit');
    const departmentId = input.fields?.departmentId;
    if (departmentId !== undefined)
      await withTenant(deps.db, ctx.tenantId, (tx) =>
        requireScopedEmploymentObject(tx, ctx, current.employeeId, departmentId, id),
      );
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await editEmploymentRecord(tx, context, id, input),
    }));
  });
  router.post('/employees/:id/import', (c) => importEmployment(c, deps));
}

async function importEmployment(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const id = uuidParam(c);
  const ctx = await readContext(c, deps, 'object.view', revision(c), id);
  const raw = await jsonBody(c);
  // DEC-199 / PR #75 第三轮 P2-3：格式与授权校验失败同样是导入任务失败，整批留任务级日志（单人导入，归属即该员工）；
  // 第五轮：逐行补任职业务编号与记录部门
  const task = {
    ...ctx,
    commandId: c.req.header('idempotency-key'),
    objectType: 'employment-record',
    total: rawImportRows(raw, 'items').length,
    scopeEmployeeId: id,
    resolveAnchors: (tx: Tx) => failedImportAnchors(tx, ctx, id, raw),
  };
  return withFailedImportLog(deps.db, task, async () => {
    const input = normalizeEmploymentImport(raw);
    await authorizeImport(deps, ctx, id, input);
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await importWithTransferAuthorization(tx, context, id, input),
    }));
  });
}

async function requirePreviewButton(deps: TenantRouteDeps, ctx: EmploymentContext) {
  await requirePermission(deps.authorize, {
    ...ctx,
    action: 'object.button',
    resource: 'TenantBase.EmploymentRecord#Employment.Preview@detail',
  });
}

async function authorizeImport(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  employeeId: string,
  input: ReturnType<typeof normalizeEmploymentImport>,
  preview = false,
) {
  if (!preview)
    await requirePermission(deps.authorize, {
      ...ctx,
      action: 'object.button',
      resource: 'TenantBase.EmploymentRecord#Employment.Import@list',
    });
  if (!preview)
    await withTenant(deps.db, ctx.tenantId, (tx) => requireImportTransferAccess(tx, ctx, employeeId, input));
  for (const item of input.items) {
    if (item.operation === 'create') {
      const business = normalizeEmploymentInput(ctx, item.business);
      if (!preview) await requireEmploymentWrite(ctx, 'create', item.business as object, 'Employment.Create');
      if (business.fields.departmentId !== undefined)
        requireEmploymentScope(ctx, employeeId, business.fields.departmentId);
    } else {
      const patch = normalizeBusinessPatch(item.patch);
      await authorizeBusinessWrite(deps, ctx, item.id, employeeId);
      await withTenant(deps.db, ctx.tenantId, (tx) => requireEmployeeTransferBusiness(tx, ctx, item.id, patch));
      if (!preview) await requireEmploymentWrite(ctx, 'update', patch, 'Employment.Edit');
      const departmentId = patch.fields?.departmentId;
      if (departmentId !== undefined)
        await withTenant(deps.db, ctx.tenantId, (tx) =>
          requireScopedEmploymentObject(tx, ctx, employeeId, departmentId, item.id),
        );
    }
  }
}

async function requireImportTransferAccess(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: ReturnType<typeof normalizeEmploymentImport>,
  preview = false,
) {
  const transfers = input.items
    .flatMap((item) => (item.operation === 'create' ? [normalizeEmploymentInput(ctx, item.business)] : []))
    .filter((business) => business.kind === 'transfer');
  if (!transfers.length) return;
  await requireTransferSource(tx, ctx, employeeId, 'hr');
  if (!preview && transfers.some((business) => business.mode === 'direct')) await requireDirectTransfer(tx, ctx);
}

async function importWithTransferAuthorization(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: ReturnType<typeof normalizeEmploymentImport>,
) {
  // 导入与单笔采用相同员工锁；批内先重验发起权限，再进入原来的整体提交端口。
  await lockImportParticipants(tx, ctx, employeeId, input);
  await lockEmploymentEmployee(tx, ctx, employeeId, ctx.expectedRevision);
  await requireImportTransferAccess(tx, ctx, employeeId, input);
  const result = await importEmploymentRecords(tx, ctx, employeeId, input);
  // R1-T16：导入整体提交，任务级日志与业务同事务
  await recordOperationLog(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    behavior: 'import',
    objectType: 'employment-record',
    objectId: employeeId,
    scopeEmployeeId: employeeId,
    successCount: input.items.length,
    failureCount: 0,
    // 逐行保存任职业务编号、员工与记录部门（PR #75 第五轮）
    items: importedItems(result.items),
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  return result;
}
