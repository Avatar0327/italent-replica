import { withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { Hono } from 'hono';
import { AppError, handleError } from '../../errors.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { jsonBody, pageQuery, revision, runWrite, trimEmploymentResponse, uuidParam } from '../employment/context.js';
import { EmploymentError } from '../employment/errors.js';
import { createTransfer } from '../transfer/service.js';
import { selfAccess, transferFieldAccess } from './access.js';
import { applicationStatus, currentRecord, ownApplication, ownApplications, ownRecords } from './queries.js';
import { ownTransferInput, ownTransferPreview } from './transfer.js';
import { readTransferCatalog } from '../transfer/configuration.js';
import { discloseOwnRecord } from './disclosure.js';
import { referenceChoices, referenceLabels } from './references.js';
import { loadEmploymentBusiness } from '../employment/read-model.js';

export const registerEmployeeSelfServiceRoutes: TenantRouteModule = (router, deps) => {
  const module = new Hono<TenantEnv>();
  module.onError((error, c) =>
    error instanceof EmploymentError
      ? c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status)
      : handleError(error, c),
  );
  registerProfileRoutes(module, deps);
  registerTransferRoutes(module, deps);
  registerApplicationRoutes(module, deps);
  router.route('/api/tenant/self-service', module);
};

function registerProfileRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.get('/profile', async (c) => {
    const self = await selfAccess(c, deps);
    const record = await withTenant(deps.db, self.ctx.tenantId, async (tx) => {
      await self.check(tx);
      return currentRecord(tx, self.ctx, self.employee.id);
    });
    return c.json({
      employee: self.employee,
      timezone: self.ctx.timezone,
      today: tenantLocalDate(self.ctx.now, self.ctx.timezone),
      record: record ? await discloseOwnRecord(self, { ...record }) : null,
    });
  });
  module.get('/employees/:id/records', async (c) => {
    const self = await selfAccess(c, deps);
    if (uuidParam(c) !== self.employee.id) throw new AppError('FORBIDDEN', '只能查看本人任职记录');
    const page = pageQuery(c);
    const rows = await withTenant(deps.db, self.ctx.tenantId, async (tx) => {
      await self.check(tx);
      return ownRecords(tx, self.ctx, self.employee.id, page);
    });
    const items = await Promise.all(
      rows.map(async ({ approvalStatus, ...record }) => ({
        ...(await discloseOwnRecord(self, record)),
        approvalStatus,
      })),
    );
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
}

function registerTransferRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.post('/transfer/preview', async (c) => {
    const self = await selfAccess(c, deps);
    const raw = await jsonBody(c);
    const result = await withTenant(deps.db, self.ctx.tenantId, async (tx) => {
      await self.check(tx);
      const preview = await ownTransferPreview(tx, self.ctx, self.employee.id, raw, deps);
      return {
        ...preview,
        valueLabels: await referenceLabels(
          tx,
          self.ctx,
          preview.fields,
          tenantLocalDate(self.ctx.now, self.ctx.timezone),
        ),
        beforeLabels: await referenceLabels(
          tx,
          self.ctx,
          preview.before?.fields ?? {},
          tenantLocalDate(self.ctx.now, self.ctx.timezone),
        ),
      };
    });
    return c.json(result);
  });
  module.get('/transfer/references/:code', async (c) => {
    const self = await selfAccess(c, deps);
    const page = pageQuery(c);
    const items = await withTenant(deps.db, self.ctx.tenantId, async (tx) => {
      await self.check(tx);
      return referenceChoices(
        tx,
        deps,
        self.ctx,
        c.req.param('code'),
        c.req.query('asOf') ?? tenantLocalDate(self.ctx.now, self.ctx.timezone),
        c.req.query('name') ?? '',
        page,
      );
    });
    return c.json({ items });
  });
  module.post('/transfer', async (c) => {
    const self = await selfAccess(c, deps, revision(c));
    const raw = await jsonBody(c);
    // 首次与幂等重放都按当前字段权限检查，事务中再次检查本人绑定。
    await withTenant(deps.db, self.ctx.tenantId, (tx) => ownTransferInput(tx, self.ctx, raw));
    return runWrite(c, self.deps, self.ctx, raw, async (tx, ctx) => {
      await self.check(tx);
      const input = await ownTransferInput(tx, ctx, raw);
      return { status: 201, body: await createTransfer(tx, ctx, self.employee.id, input) };
    });
  });
}

function registerApplicationRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.get('/applications', async (c) => {
    const self = await selfAccess(c, deps);
    const page = pageQuery(c);
    const rows = await withTenant(deps.db, self.ctx.tenantId, async (tx) => {
      await self.check(tx);
      return ownApplications(tx, self.ctx, self.employee.id, page);
    });
    const visible = await withTenant(deps.db, self.ctx.tenantId, (tx) => transferFieldAccess(tx, deps, self.ctx));
    const items = await Promise.all(
      rows.map(async ({ state, departmentId, reasonCode, ...item }) => ({
        ...item,
        status: applicationStatus(state),
        category: '人事变动',
        initiator: self.employee.name,
        reason:
          reasonCode && visible.has('reasonCode')
            ? await withTenant(
                deps.db,
                self.ctx.tenantId,
                async (tx) =>
                  (await readTransferCatalog(tx, self.ctx.tenantId, item.effectiveDate)).reasons.find(
                    (r) => r.code === reasonCode,
                  )?.name ?? '',
              )
            : '',
        ...((await trimEmploymentResponse(self.deps, self.ctx, { fields: { departmentId } })) as object),
      })),
    );
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
  module.get('/applications/:id', async (c) => {
    const self = await selfAccess(c, deps);
    const id = uuidParam(c);
    const result = await withTenant(deps.db, self.ctx.tenantId, async (tx) => {
      await self.check(tx);
      const item = await ownApplication(tx, self.ctx, self.employee.id, id);
      const business = await loadEmploymentBusiness(
        tx,
        self.ctx.tenantId,
        item.businessId,
        tenantLocalDate(self.ctx.now, self.ctx.timezone),
        self.ctx.scope,
      );
      if (!business) throw new AppError('NOT_FOUND', '申请不存在');
      return { item, business };
    });
    return c.json({
      status: applicationStatus(result.item.state),
      record: await discloseOwnRecord(self, { ...result.business }),
    });
  });
}
