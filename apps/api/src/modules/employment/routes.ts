import { withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { AppError, handleError } from '../../errors.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { scopeAllows } from '../permission/module-access.js';
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
import { createEmployee, getEmployee, listEmployees } from './employees.js';
import { EmploymentError } from './errors.js';
import { normalizeEmploymentInput, normalizeBusinessPatch } from './fields.js';
import { previewEmploymentEditForwardUpdate, previewEmploymentForwardUpdate } from './forward-preview.js';
import { importEmploymentRecords, normalizeEmploymentImport, previewEmploymentImport } from './forward-import.js';
import { editEmploymentRecord } from './record-edit.js';
import { prepareInheritance, inheritancePreview } from './inheritance.js';
import { listEmploymentRecords, loadEmploymentBusiness, loadEmploymentRecord } from './read-model.js';
import { createEmploymentBusiness, updateEmploymentBusiness } from './write-service.js';
import { transitionEmployment } from './transitions.js';
import type { EmploymentContext } from './types.js';

export const registerEmploymentRoutes: TenantRouteModule = (router, deps) => {
  const module = new Hono<TenantEnv>();
  module.onError((error, c) => {
    if (error instanceof EmploymentError) {
      return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
    }
    return handleError(error, c);
  });
  registerEmployees(module, deps);
  registerEmployeeRecords(module, deps);
  registerInheritancePreview(module, deps);
  registerBusinesses(module, deps);
  registerForwardUpdates(module, deps);
  registerSettings(module, deps);
  registerCustomFields(module, deps);
  router.route('/api/tenant/employment', module);
};

function registerEmployees(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/employees', async (c) => {
    const ctx = await readContext(c, deps, 'object.create', revision(c), undefined, EMPLOYEE_OBJECT);
    const input = parse(
      z.strictObject({ code: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(200) }),
      await jsonBody(c),
    );
    await requireEmploymentWrite(ctx, 'create', input, 'Employee.Create', EMPLOYEE_OBJECT);
    // TODO(需取证 Q-M0-28)：新员工尚无任职鉴权字段，仅显式看全部范围可创建。
    requireEmploymentScope(ctx);
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 201,
      body: await createEmployee(tx, context, input),
    }));
  });
  router.get('/employees', async (c) => {
    const ctx = await readPageContext(c, deps, 'list', undefined, EMPLOYEE_OBJECT);
    const page = pageQuery(c);
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
  router.post('/employees/:id/businesses', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.create', revision(c), id);
    const rawInput = await jsonBody(c);
    const input = normalizeEmploymentInput(ctx, rawInput);
    await requireEmploymentWrite(ctx, 'create', rawInput as object, 'Employment.Create');
    if (input.fields.departmentId !== undefined) requireEmploymentScope(ctx, id, input.fields.departmentId);
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 201,
      body: await createEmploymentBusiness(tx, context, id, input),
    }));
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
      if (!rows.length && ctx.scope && !scopeAllows(ctx.scope, { personId: id })) {
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
    const ctx = await readPageContext(c, deps, 'detail');
    const value = await withTenant(deps.db, ctx.tenantId, (tx) =>
      loadEmploymentBusiness(tx, ctx.tenantId, id, queryDate(c, ctx), ctx.scope),
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
      body: await updateEmploymentBusiness(tx, context, id, input),
    }));
  });
  for (const action of ['submit', 'withdraw', 'delete'] as const) {
    router.on(
      action === 'delete' ? 'DELETE' : 'POST',
      `/businesses/:id${action === 'delete' ? '' : `/${action}`}`,
      async (c) => {
        const id = uuidParam(c);
        const ctx = await readContext(c, deps, action === 'delete' ? 'object.delete' : 'object.update', revision(c));
        await requireEmploymentWrite(
          ctx,
          action === 'delete' ? 'delete' : 'update',
          {},
          `Employment.${action[0]!.toUpperCase()}${action.slice(1)}`,
        );
        await authorizeBusinessWrite(deps, ctx, id);
        return runWrite(c, deps, ctx, { id, action }, async (tx, context) => ({
          status: 200,
          body: await transitionEmployment(tx, context, { id, action }),
        }));
      },
    );
  }
}

async function authorizeBusinessWrite(deps: TenantRouteDeps, ctx: EmploymentContext, id: string, employeeId?: string) {
  // 幂等重放也重验当前范围，不能依赖可能被命令台账跳过的 execute。
  const value = await withTenant(deps.db, ctx.tenantId, (tx) =>
    loadEmploymentBusiness(tx, ctx.tenantId, id, tenantLocalDate(ctx.now, ctx.timezone), ctx.scope),
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
  router.post('/employees/:id/import', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.view', revision(c), id);
    const input = normalizeEmploymentImport(await jsonBody(c));
    await authorizeImport(deps, ctx, id, input);
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await importEmploymentRecords(tx, context, id, input),
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
  for (const item of input.items) {
    if (item.operation === 'create') {
      const business = normalizeEmploymentInput(ctx, item.business);
      if (!preview) await requireEmploymentWrite(ctx, 'create', item.business as object, 'Employment.Create');
      if (business.fields.departmentId !== undefined)
        requireEmploymentScope(ctx, employeeId, business.fields.departmentId);
    } else {
      const patch = normalizeBusinessPatch(item.patch);
      await authorizeBusinessWrite(deps, ctx, item.id, employeeId);
      if (!preview) await requireEmploymentWrite(ctx, 'update', patch, 'Employment.Edit');
      const departmentId = patch.fields?.departmentId;
      if (departmentId !== undefined)
        await withTenant(deps.db, ctx.tenantId, (tx) =>
          requireScopedEmploymentObject(tx, ctx, employeeId, departmentId, item.id),
        );
    }
  }
}
