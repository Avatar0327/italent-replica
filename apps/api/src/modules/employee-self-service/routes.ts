import { withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { Hono } from 'hono';
import { AppError, handleError } from '../../errors.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { jsonBody, pageQuery, revision, runWrite, uuidParam } from '../employment/context.js';
import { EmploymentError } from '../employment/errors.js';
import { createTransfer } from '../transfer/service.js';
import type { CommandGuard } from '../../commands.js';
import { requireSelfServiceButtons, type SelfAccess, selfAccess, transferFieldAccess } from './access.js';
import { applicationStatus, currentRecord, ownApplication, ownApplications, ownRecords } from './queries.js';
import { ownTransferInput, ownTransferPreview } from './transfer.js';
import { readTransferCatalog } from '../transfer/configuration.js';
import { discloseOwnRecord } from './disclosure.js';
import { visibleFields } from './field-disclosure.js';
import { referenceChoices } from './references.js';
import { loadEmploymentBusiness } from '../employment/read-model.js';
import { policedSub } from '../../route-policy/index.js';
import { SELF_SERVICE_POLICIES } from './policy.js';

export const registerEmployeeSelfServiceRoutes: TenantRouteModule = (router, deps) => {
  // F-039：子应用套本模块登记表（SELF_SERVICE_POLICIES），注册行不变、处理函数不变
  const module = policedSub(router, SELF_SERVICE_POLICIES, () => new Hono<TenantEnv>());
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
      return ownTransferPreview(tx, self.ctx, self.employee.id, raw, deps);
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
        c.req.query('departmentId'),
      );
    });
    return c.json({ items });
  });
  module.post('/transfer', async (c) => {
    const self = await selfAccess(c, deps, revision(c));
    const raw = await jsonBody(c);
    // 首次与幂等重放都按当前字段权限检查，事务中再次检查本人绑定。
    await withTenant(deps.db, self.ctx.tenantId, (tx) => ownTransferInput(tx, self.ctx, raw, deps));
    const commandInput = { employeeId: self.employee.id, input: raw };
    return runWrite(
      c,
      self.deps,
      self.ctx,
      commandInput,
      async (tx, ctx) => {
        await self.check(tx);
        const input = await ownTransferInput(tx, ctx, raw, deps);
        return { status: 201, body: await createTransfer(tx, ctx, self.employee.id, input) };
      },
      { guard: selfTransferGuard(self) },
    );
  });
}

/**
 * 三个本人调动按钮的命令内复核（契约 §2.3.1）：接 CommandGuard.before，runCommand 的三个出口（首次执行、直接重放、失败后回查）
 * 都经 ledgerExit 先过它，所以撤权后重放拿不到原 201。只设 before：结果可见性仍由 runWrite 返回后的 authorizeEmploymentResult 复核。
 * 工厂放在这里而不是 access.ts：检查函数留在 access.ts，才能让 F-039 的 delete-precondition 变异体生成。
 */
function selfTransferGuard(self: SelfAccess): CommandGuard {
  return { before: (tx) => requireSelfServiceButtons(tx, self.ctx) };
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
        id: item.id,
        businessId: item.businessId,
        revision: item.revision,
        title: item.title,
        currentHandlers: item.currentHandlers,
        createdAt: item.createdAt,
        ...visibleFields({ effectiveDate: item.effectiveDate }, visible),
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
        fields: visibleFields({ departmentId }, visible),
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
