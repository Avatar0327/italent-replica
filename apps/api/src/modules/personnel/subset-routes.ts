import { sql, withTenant } from '@italent/db';
import { SUBSETS } from '@italent/domain';
import type { Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery, revision, uuidParam } from '../job/context.js';
import { access, preflight, trim } from './access.js';
import { body, safe, write } from './http.js';
import { listOptions, listSubsets, subsetDto, trimSubset } from './lists.js';
import { rows } from './store.js';
import { loadSubset, saveSubset } from './subsets.js';
import { subsetInput, subsetKind } from './validation.js';

const root = '/api/tenant/personnel';
const base = `${root}/employees/:employeeId/subsets/:kind`;
export function registerSubsetRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  for (const path of [base, `${root}/subsets/:kind`])
    router.get(path, (c) =>
      safe(async () => {
        const kind = subsetKind(c.req.param('kind') ?? '');
        const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'view', {}, undefined, 0, 'list');
        const employeeId = c.req.param('employeeId') ? uuidParam(c, 'employeeId') : undefined;
        if (employeeId) await preflight(deps, ctx, employeeId);
        const page = pageQuery(c);
        const options = await listOptions(c, deps, ctx);
        const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
          listSubsets(tx, ctx, kind, page, options, employeeId),
        );
        return c.json({
          items: await Promise.all(items.map((row) => trimSubset(deps, ctx, row))),
          page: page.page,
          pageSize: page.pageSize,
          hasDataPermission: ctx.scope.hasDataPermission,
        });
      }),
    );
  registerReads(router, deps);
  registerWrites(router, deps);
}
function registerReads(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${base}/:id`, (c) =>
    safe(async () => {
      const kind = subsetKind(c.req.param('kind') ?? '');
      const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'view');
      const employeeId = uuidParam(c, 'employeeId');
      await preflight(deps, ctx, employeeId);
      const item = await withTenant(deps.db, ctx.tenantId, (tx) => loadSubset(tx, ctx, employeeId, kind, uuidParam(c)));
      return c.json(await trim(deps, ctx, ctx.objectCode, subsetDto(item, kind)));
    }),
  );
  router.get(`${base}/:id/history`, (c) =>
    safe(async () => {
      const kind = subsetKind(c.req.param('kind') ?? '');
      const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'view', {}, 'history');
      const employeeId = uuidParam(c, 'employeeId');
      const id = uuidParam(c);
      await preflight(deps, ctx, employeeId);
      const page = pageQuery(c);
      const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
        await loadSubset(tx, ctx, employeeId, kind, id, true);
        return rows(
          await tx.execute(sql`SELECT * FROM ${sql.identifier(`${SUBSETS[kind].table}_versions`)}
        WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND record_id=${id}::uuid
        ORDER BY revision DESC LIMIT ${page.limit} OFFSET ${page.offset}`),
        ).map((r) => subsetDto(r, kind));
      });
      return c.json({
        items: await Promise.all(items.map((row) => trim(deps, ctx, ctx.objectCode, row))),
        page: page.page,
        pageSize: page.pageSize,
      });
    }),
  );
}
function registerWrites(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post(base, (c) =>
    safe(async () => {
      const kind = subsetKind(c.req.param('kind') ?? '');
      const input = subsetInput(kind, await body(c));
      const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'create', input, 'create', revision(c));
      const employeeId = uuidParam(c, 'employeeId');
      return write(c, deps, ctx, employeeId, 'create', input, (tx, ctx) =>
        saveSubset(tx, ctx, employeeId, kind, input),
      );
    }),
  );
  router.patch(`${base}/:id`, (c) =>
    safe(async () => {
      const kind = subsetKind(c.req.param('kind') ?? '');
      const input = subsetInput(kind, await body(c));
      const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'update', input, 'update', revision(c));
      const employeeId = uuidParam(c, 'employeeId');
      const id = uuidParam(c);
      return write(c, deps, ctx, employeeId, 'update', input, (tx, ctx) =>
        saveSubset(tx, ctx, employeeId, kind, input, id),
      );
    }),
  );
  router.delete(`${base}/:id`, (c) =>
    safe(async () => {
      const kind = subsetKind(c.req.param('kind') ?? '');
      const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'delete', {}, 'delete', revision(c));
      const employeeId = uuidParam(c, 'employeeId');
      const id = uuidParam(c);
      return write(c, deps, ctx, employeeId, 'delete', {}, (tx, ctx) =>
        saveSubset(tx, ctx, employeeId, kind, {}, id, true),
      );
    }),
  );
}
