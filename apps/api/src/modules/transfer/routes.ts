import { withTenant } from '@italent/db';
import { tenantLocalDate, buttonResource } from '@italent/domain';
import type { Hono, Context } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  readContext,
  readPageContext,
  jsonBody,
  revision,
  uuidParam,
  runWrite,
  trimEmploymentResponse,
  requireEmploymentWrite,
  pageQuery,
} from '../employment/context.js';
import { businessDate } from '../employment/fields.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import { loadOrgSnapshot } from '../org/read-model.js';
import {
  readTransferCatalog,
  readTransferSettings,
  updateTransferSettings,
  resolveTransferForm,
  saveTransferForm,
} from './configuration.js';
import { previewTransfer } from './preview.js';
import { createTransfer, normalizeTransferInput, requireTransferWrite, requireDirectTransfer } from './service.js';

export function registerTransferRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/transfers/catalog', async (c) => {
    const ctx = await readPageContext(c, deps, 'detail');
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const effectiveDate = businessDate(c.req.query('effectiveDate') ?? today);
    const catalog = await withTenant(deps.db, ctx.tenantId, (tx) =>
      readTransferCatalog(tx, ctx.tenantId, effectiveDate),
    );
    return c.json({ ...catalog, today });
  });
  router.get('/transfers/departments', async (c) => {
    const ctx = await readPageContext(c, deps, 'detail');
    const permitted = await Promise.all(
      ['Transfer.Hr', 'Transfer.Manager', 'Transfer.Self'].map((button) =>
        deps.authorize({
          ...ctx,
          action: 'object.button',
          resource: buttonResource('TenantBase.EmploymentRecord', button, 'detail'),
        }),
      ),
    );
    if (!ctx.scope?.hasDataPermission || !permitted.some(Boolean)) throw new AppError('FORBIDDEN', '无权选择调动部门');
    const effectiveDate = businessDate(c.req.query('effectiveDate') ?? tenantLocalDate(ctx.now, ctx.timezone));
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const form = await resolveTransferForm(
        tx,
        ctx.tenantId,
        c.req.query('formId') ?? 'TenantBase.TransferMultiFormView',
      );
      const settings = await readTransferSettings(tx, ctx.tenantId);
      const organizations = await loadOrgSnapshot(tx, ctx.tenantId, effectiveDate, page, {
        includeDisabled: false,
        ...(form.isStandard && settings.unrestrictTargetDepartment ? {} : { scope: ctx.scope }),
      });
      return organizations.map(({ id, name, code }) => ({ id, name, code }));
    });
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
  router.post('/transfers/employees/:id/preview', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'detail');
    const raw = await jsonBody(c);
    const preview = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const input = await normalizeTransferInput(tx, ctx, raw);
      return previewTransfer(tx, ctx, id, input);
    });
    const { form, employeeRevision, allowDirectTransfer, allowedActions } = preview.value;
    const viewable = await getModuleViewableFields(deps, ctx, 'TenantBase.EmploymentRecord');
    return c.json({
      ...((await trimEmploymentResponse(deps, ctx, preview.value)) as object),
      form: {
        ...form,
        customFields: form.customFields.filter((field) => viewable === undefined || viewable.has(`custom:${field.id}`)),
      },
      employeeRevision,
      allowDirectTransfer,
      allowedActions,
    });
  });
  router.post('/transfers/employees/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.create', revision(c));
    const raw = await jsonBody(c);
    const prepared = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const input = await normalizeTransferInput(tx, ctx, raw);
      const preview = await previewTransfer(tx, ctx, id, input);
      if (input.employment.mode === 'direct') await requireDirectTransfer(tx, preview.context);
      return { input, context: preview.context };
    });
    await requireTransferWrite(prepared.context, prepared.input);
    return runWrite(c, deps, prepared.context, raw, async (tx, context) => ({
      status: 201,
      body: await createTransfer(tx, context, id, prepared.input),
    }));
  });
  registerTransferConfiguration(router, deps);
}

function registerTransferConfiguration(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/transfers/settings', async (c) => {
    const ctx = await configurationContext(c, deps, false);
    const settings = await withTenant(deps.db, ctx.tenantId, (tx) => readTransferSettings(tx, ctx.tenantId));
    return c.json(await trimEmploymentResponse(deps, ctx, settings));
  });
  router.put('/transfers/settings', async (c) => {
    const ctx = await configurationContext(c, deps, true);
    const input = parse(
      z.strictObject({ unrestrictTargetDepartment: z.boolean(), autoPopulate: z.boolean() }),
      await jsonBody(c),
    );
    await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await updateTransferSettings(tx, context, input),
    }));
  });
  router.put('/transfers/forms/:formId', async (c) => {
    const ctx = await configurationContext(c, deps, true);
    const input = parse(
      z.strictObject({
        name: z.string().trim().min(1).max(200),
        group: z.literal('transfer').nullable(),
        processCode: z.string().trim().min(1).max(100).optional(),
        fieldModes: z.record(z.string(), z.enum(['editable', 'readonly', 'hidden', 'absent'])),
      }),
      await jsonBody(c),
    );
    const formId = parse(z.string().trim().min(1).max(100), c.req.param('formId'));
    return runWrite(c, deps, ctx, { id: formId, ...input }, async (tx, context) => ({
      status: 200,
      body: await saveTransferForm(tx, context, { id: formId, ...input }),
    }));
  });
}

function configurationContext(c: Context<TenantEnv>, deps: TenantRouteDeps, write: boolean) {
  return readContext(
    c,
    deps,
    write ? 'tenant.employment.configuration.write' : 'object.view',
    write ? revision(c) : 0,
    undefined,
    'TenantBase.EmploymentSettings',
  );
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '调动配置字段不合法', parsed.error.issues);
  return parsed.data;
}
