import { employmentBusinessObjects, eq, withTenant } from '@italent/db';
import { Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { AppError, handleError } from '../../errors.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  readSettings,
  updateSettings,
  createCustomField,
  setCustomFieldInheritance,
  listCustomFields,
} from './configuration.js';
import { readContext, jsonBody, pageQuery, revision, queryDate, runWrite, uuidParam } from './context.js';
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
  registerBusinesses(module, deps);
  registerForwardUpdates(module, deps);
  registerSettings(module, deps);
  registerCustomFields(module, deps);
  router.route('/api/tenant/employment', module);
};

function registerEmployees(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/employees', async (c) => {
    const ctx = await readContext(c, deps, 'tenant.employment.write', revision(c));
    const input = parse(
      z.strictObject({ code: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(200) }),
      await jsonBody(c),
    );
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 201,
      body: await createEmployee(tx, context, input),
    }));
  });
  router.get('/employees', async (c) => {
    const ctx = await readContext(c, deps, 'tenant.employment.read');
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listEmployees(tx, ctx.tenantId, queryDate(c, ctx), page, {
        code: c.req.query('code'),
        name: c.req.query('name'),
        status: parse(z.enum(['pending', 'employed', 'left', 'retired']).optional(), c.req.query('status')),
      }),
    );
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
  router.get('/employees/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'tenant.employment.read', 0, id);
    const employee = await withTenant(deps.db, ctx.tenantId, (tx) =>
      getEmployee(tx, ctx.tenantId, id, queryDate(c, ctx)),
    );
    if (!employee) throw new AppError('NOT_FOUND', '员工不存在');
    return c.json(employee);
  });
  router.get('/employees/:id/records', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'tenant.employment.read', 0, id);
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      if (!(await getEmployee(tx, ctx.tenantId, id, queryDate(c, ctx)))) throw new AppError('NOT_FOUND', '员工不存在');
      return listEmploymentRecords(tx, ctx.tenantId, id, queryDate(c, ctx), page);
    });
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
  router.post('/employees/:id/businesses', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'tenant.employment.write', revision(c), id);
    const input = normalizeEmploymentInput(ctx, await jsonBody(c));
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 201,
      body: await createEmploymentBusiness(tx, context, id, input),
    }));
  });
  router.post('/employees/:id/preview', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'tenant.employment.read', 0, id);
    const input = normalizeEmploymentInput(ctx, await jsonBody(c));
    const prepared = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      if (!(await getEmployee(tx, ctx.tenantId, id, queryDate(c, ctx)))) throw new AppError('NOT_FOUND', '员工不存在');
      return prepareInheritance(tx, ctx, { ...input, employeeId: id });
    });
    return c.json(inheritancePreview(prepared));
  });
}

function registerBusinesses(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/businesses/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'tenant.employment.read');
    const value = await withTenant(deps.db, ctx.tenantId, (tx) =>
      loadEmploymentBusiness(tx, ctx.tenantId, id, queryDate(c, ctx)),
    );
    if (!value) throw new AppError('NOT_FOUND', '任职业务不存在');
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: value.employeeId });
    return c.json(value);
  });
  router.get('/records/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'tenant.employment.read');
    const value = await withTenant(deps.db, ctx.tenantId, (tx) =>
      loadEmploymentRecord(tx, ctx.tenantId, id, queryDate(c, ctx)),
    );
    if (!value) throw new AppError('NOT_FOUND', '任职记录不存在');
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: value.employeeId });
    return c.json(value);
  });
  router.patch('/businesses/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'tenant.employment.write', revision(c));
    const input = normalizeBusinessPatch(await jsonBody(c));
    await authorizeBusinessWrite(deps, ctx, id);
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
        const ctx = await readContext(c, deps, 'tenant.employment.write', revision(c));
        await authorizeBusinessWrite(deps, ctx, id);
        return runWrite(c, deps, ctx, { id, action }, async (tx, context) => ({
          status: 200,
          body: await transitionEmployment(tx, context, { id, action }),
        }));
      },
    );
  }
}

async function authorizeBusinessWrite(deps: TenantRouteDeps, ctx: EmploymentContext, id: string): Promise<void> {
  // AGENTS §10：幂等重放也必须重验当前员工范围，不能把检查放在会被台账跳过的 execute 内。
  const employeeId = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({ employeeId: employmentBusinessObjects.employeeId })
      .from(employmentBusinessObjects)
      .where(eq(employmentBusinessObjects.id, id))
      .limit(1);
    return row?.employeeId;
  });
  if (!employeeId) throw new AppError('NOT_FOUND', '任职业务不存在');
  await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.write', resource: employeeId });
}

function registerSettings(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/settings', async (c) => {
    const ctx = await readContext(c, deps, 'tenant.employment.read');
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => readSettings(tx, ctx.tenantId)));
  });
  router.put('/settings', async (c) => {
    const ctx = await readContext(c, deps, 'tenant.employment.configuration.write', revision(c));
    const input = parse(z.strictObject({ allowDirectTransfer: z.boolean() }), await jsonBody(c));
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await updateSettings(tx, context, input),
    }));
  });
}

function registerCustomFields(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post('/custom-fields', async (c) => {
    const ctx = await readContext(c, deps, 'tenant.employment.configuration.write', revision(c));
    const input = parse(
      z.strictObject({
        name: z.string().trim().min(1).max(200),
        valueType: z.enum(['text', 'integer', 'decimal', 'boolean', 'date']),
        objectType: z.enum(['employment', 'contract']),
      }),
      await jsonBody(c),
    );
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 201,
      body: await createCustomField(tx, context, input),
    }));
  });
  router.get('/custom-fields', async (c) => {
    const ctx = await readContext(c, deps, 'tenant.employment.read');
    const page = pageQuery(c);
    const objectType = parse(z.enum(['employment', 'contract']).optional(), c.req.query('objectType'));
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listCustomFields(tx, ctx.tenantId, page, objectType));
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
  router.put('/custom-fields/:id/inheritance', async (c) => {
    const ctx = await readContext(c, deps, 'tenant.employment.configuration.write', revision(c));
    const id = uuidParam(c);
    const input = parse(z.strictObject({ inherit: z.boolean() }), await jsonBody(c));
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
    const ctx = await readContext(c, deps, 'tenant.employment.read', 0, id);
    const input = normalizeEmploymentInput(ctx, await jsonBody(c));
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => previewEmploymentForwardUpdate(tx, ctx, id, input)));
  });
  router.post('/records/:id/forward-update-preview', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'tenant.employment.read');
    const input = normalizeBusinessPatch(await jsonBody(c));
    const value = await withTenant(deps.db, ctx.tenantId, (tx) =>
      loadEmploymentBusiness(tx, ctx.tenantId, id, queryDate(c, ctx)),
    );
    if (!value) throw new AppError('NOT_FOUND', '任职业务不存在');
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: value.employeeId });
    return c.json(
      await withTenant(deps.db, ctx.tenantId, (tx) => previewEmploymentEditForwardUpdate(tx, ctx, id, input)),
    );
  });
  router.post('/employees/:id/import/forward-update-preview', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'tenant.employment.read', 0, id);
    const input = normalizeEmploymentImport(await jsonBody(c));
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => previewEmploymentImport(tx, ctx, id, input)));
  });
  router.patch('/records/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'tenant.employment.write', revision(c));
    const input = normalizeBusinessPatch(await jsonBody(c));
    await authorizeBusinessWrite(deps, ctx, id);
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await editEmploymentRecord(tx, context, id, input),
    }));
  });
  router.post('/employees/:id/import', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'tenant.employment.write', revision(c), id);
    const input = normalizeEmploymentImport(await jsonBody(c));
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await importEmploymentRecords(tx, context, id, input),
    }));
  });
}
