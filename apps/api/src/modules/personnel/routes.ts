import { sql, withTenant } from '@italent/db';
import { PERSONNEL_OBJECT, SUBSETS, tenantLocalDate, type SubsetKind } from '@italent/domain';
import type { Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery, revision, uuidParam } from '../job/context.js';
import { resolveModuleScope } from '../permission/module-access.js';
import { access, preflight, trim, type AccessContext } from './access.js';
import { readEmployee, readTenure } from './employee-read.js';
import { appendEmployee } from './employee-write.js';
import { body, safe, write } from './http.js';
import { listEmployees, listOptions, listSubsets, trimSubset } from './lists.js';
import { registerSubsetRoutes } from './subset-routes.js';
import { registerChangeRequestRoutes } from './request-routes.js';
import { camel, rows } from './store.js';
import { dateValue, employeeInput } from './validation.js';

const base = '/api/tenant/personnel/employees';
export function registerPersonnelRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(base, (c) =>
    safe(async () => {
      const ctx = await access(c, deps, PERSONNEL_OBJECT, 'view', {}, undefined, 0, 'list');
      const page = pageQuery(c);
      const options = await listOptions(c, deps, ctx);
      const items = await withTenant(deps.db, ctx.tenantId, (tx) => listEmployees(tx, ctx, page, options));
      return c.json({
        items: await Promise.all(items.map((r) => trim(deps, ctx, PERSONNEL_OBJECT, r))),
        page: page.page,
        pageSize: page.pageSize,
        hasDataPermission: ctx.scope.hasDataPermission,
      });
    }),
  );
  router.get(`${base}/:id`, (c) =>
    safe(async () => {
      const ctx = await access(c, deps, PERSONNEL_OBJECT, 'view');
      const id = uuidParam(c);
      await preflight(deps, ctx, id);
      const employee = await withTenant(deps.db, ctx.tenantId, async (tx) => ({
        ...(await readEmployee(tx, ctx, id)),
        ...(await readTenure(tx, ctx, id, tenantLocalDate(ctx.now, ctx.timezone))),
      }));
      const result = await trim(deps, ctx, PERSONNEL_OBJECT, employee);
      if (c.req.query('includeSubsets') === 'true') result.subsets = await nestedSubsets(deps, ctx, id);
      return c.json(result);
    }),
  );
  router.patch(`${base}/:id`, (c) =>
    safe(async () => {
      const input = employeeInput(await body(c));
      const ctx = await access(c, deps, PERSONNEL_OBJECT, 'update', input, 'update', revision(c));
      const id = uuidParam(c);
      return write(c, deps, ctx, id, 'update', input, async (tx, ctx) => {
        await appendEmployee(tx, ctx, id, input);
        return readEmployee(tx, ctx, id);
      });
    }),
  );
  registerEmployeeReads(router, deps);
  registerSubsetRoutes(router, deps);
  registerChangeRequestRoutes(router, deps);
}
function registerEmployeeReads(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${base}/:id/tenure`, (c) =>
    safe(async () => {
      const ctx = await access(c, deps, PERSONNEL_OBJECT, 'view');
      const id = uuidParam(c);
      await preflight(deps, ctx, id);
      const asOf = dateValue(c.req.query('asOf') ?? tenantLocalDate(ctx.now, ctx.timezone));
      const result = await withTenant(deps.db, ctx.tenantId, (tx) => readTenure(tx, ctx, id, asOf));
      return c.json(await trim(deps, ctx, PERSONNEL_OBJECT, result));
    }),
  );
  router.get(`${base}/:id/history`, (c) =>
    safe(async () => {
      const ctx = await access(c, deps, PERSONNEL_OBJECT, 'view', {}, 'history');
      const id = uuidParam(c);
      await preflight(deps, ctx, id);
      const page = pageQuery(c);
      const items = await withTenant(deps.db, ctx.tenantId, async (tx) =>
        rows(
          await tx.execute(sql`
      SELECT * FROM personnel_employee_versions WHERE tenant_id=${ctx.tenantId} AND employee_id=${id}::uuid
      ORDER BY revision DESC LIMIT ${page.limit} OFFSET ${page.offset}`),
        ).map(camel),
      );
      return c.json({
        items: await Promise.all(items.map((r) => trim(deps, ctx, PERSONNEL_OBJECT, r))),
        page: page.page,
        pageSize: page.pageSize,
      });
    }),
  );
}
async function nestedSubsets(deps: TenantRouteDeps, ctx: AccessContext, id: string) {
  const result: Record<string, unknown> = {};
  for (const kind of Object.keys(SUBSETS) as SubsetKind[]) {
    const objectCode = SUBSETS[kind].objectCode;
    if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: objectCode }))) continue;
    const scope = await resolveModuleScope(deps, ctx, undefined, objectCode, `${objectCode}.list`);
    const context = { ...ctx, objectCode, scope };
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listSubsets(tx, context, kind, { limit: 50, offset: 0 }, { order: sql``, filter: sql`true` }, id),
    );
    result[kind] = { items: await Promise.all(items.map((row) => trimSubset(deps, context, row))), pageSize: 50 };
  }
  return result;
}
