import { AppError, handleError } from '../../errors.js';
import { pgErrorCode, sql, withTenant, contractTypes, contractCompanies, type Tx } from '@italent/db';
import { CONTRACT_OBJECT, buttonResource, contractAction } from '@italent/domain';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { runCommand, type CommandResult } from '../../commands.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { pageQuery, revision, uuidParam } from '../job/context.js';
import { jsonBody } from '../employment/context.js';
import {
  resolveModuleScope,
  resolveModuleScopeInTransaction,
  getModuleViewableFields,
  getModuleViewableFieldsInTransaction,
  authorizeInTransaction,
} from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { checkFields, checkScope, rowsOf, type ContractContext } from './context.js';
import { rules, saveMaster, saveRule, saveSettings, settings } from './configuration.js';
import { commandSchema, parse } from './input.js';
import { batchCommands, createCommand, loadContract, loadRequest, portfolioRevision } from './service.js';
import { listContracts } from './queries.js';
import { errorsCsv, importContracts, importSchema, previewImport } from './imports.js';
import { cancelFailedRequest } from './recovery.js';
import { registerMergedTodos } from './todos.js';

type C = Context<TenantEnv>;
export async function routeContext(c: C, deps: TenantRouteDeps, object = CONTRACT_OBJECT, write = false) {
  const tenant = tenantOf(c);
  const ctx: ContractContext = {
    ...tenant,
    now: deps.clock(),
    commandId: '',
    expectedRevision: write ? revision(c) : 0,
    authorize: deps.authorize,
    fields: {
      viewable: (tx, userId, objectCode) =>
        getModuleViewableFieldsInTransaction(deps, { ...tenant, userId }, objectCode, tx),
    },
    scope: await resolveModuleScope(deps, tenant, undefined, object, `${object}.list`),
  };
  if (!write)
    await requirePermission(deps.authorize, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: 'object.view',
      resource: object,
    });
  return ctx;
}
async function trim(deps: TenantRouteDeps, ctx: ContractContext, object: string, value: unknown): Promise<unknown> {
  const fields = await getModuleViewableFields(deps, ctx, object);
  if (fields === undefined) return value;
  function project(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(project);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (key === 'items') return [[key, project(item)]];
        if (key === 'customFields')
          return [
            [key, Object.fromEntries(Object.entries(item as object).filter(([id]) => fields!.has(`custom:${id}`)))],
          ];
        if (['page', 'pageSize', 'hasDataPermission', 'count'].includes(key) || fields!.has(key)) return [[key, item]];
        return [];
      }),
    );
  }
  return project(value);
}
function requireMasterScope(ctx: ContractContext, object: string) {
  if (['TenantBase.ContractType', 'TenantBase.ContractCompany'].includes(object) && !ctx.scope?.all)
    throw new AppError('NOT_FOUND', '合同主数据不存在');
}
export async function write(
  c: C,
  deps: TenantRouteDeps,
  ctx: ContractContext,
  input: unknown,
  execute: (tx: Tx, ctx: ContractContext) => Promise<CommandResult>,
  object = CONTRACT_OBJECT,
) {
  requireMasterScope(ctx, object);
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input },
    execute: async (tx, commandId) => {
      const current = {
        ...ctx,
        commandId,
        authorize: authorizeInTransaction(deps.authorize, tx),
        scope: await resolveModuleScopeInTransaction(deps, ctx, tx, object, `${object}.list`),
      };
      requireMasterScope(current, object);
      return execute(tx, current);
    },
  });
  ctx = { ...ctx, scope: await resolveModuleScope(deps, ctx, undefined, object, `${object}.list`) };
  requireMasterScope(ctx, object);
  // 台账重放按当前权限裁剪，并重新验证每个结果的员工范围。
  if (object === CONTRACT_OBJECT)
    await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const check = async (value: unknown): Promise<void> => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          for (const item of value) await check(item);
          return;
        }
        const row = value as Record<string, unknown>;
        if (typeof row.employeeId === 'string')
          await checkScope(tx, ctx, row.employeeId, typeof row.createdBy === 'string' ? row.createdBy : undefined);
        if (row.items) await check(row.items);
      };
      await check(result.body);
    });
  return c.json(await trim(deps, ctx, object, result.body), result.status);
}
export const registerContractRoutes: TenantRouteModule = (router, deps) => {
  const module = new Hono<TenantEnv>();
  module.onError((error, c) => {
    const code = pgErrorCode(error);
    if (code === '23505') return handleError(new AppError('CONFLICT', '合同编号或主数据编码已存在'), c);
    if (['40P01', '40001', '55P03'].includes(code ?? '')) {
      return handleError(new AppError('REVISION_CONFLICT', '数据正在变更，请刷新后显式重提'), c);
    }
    return handleError(error, c);
  });
  module.get('/', async (c) => {
    const ctx = await routeContext(c, deps);
    const page = pageQuery(c);
    const view = parse(
      z.enum(['all', 'valid', 'expiring', 'expired_unrenewed', 'missing', 'in_review']),
      c.req.query('view') ?? 'all',
    );
    const days = view === 'expiring' ? parse(z.coerce.number().int().min(1).max(3660), c.req.query('days')) : 0;
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listContracts(tx, ctx, view, page.limit, page.offset, days),
    );
    return c.json(
      await trim(deps, ctx, CONTRACT_OBJECT, {
        items,
        page: page.page,
        pageSize: page.pageSize,
        hasDataPermission: ctx.scope?.hasDataPermission ?? false,
      }),
    );
  });
  module.get('/employees/:id/revision', async (c) => {
    const ctx = await routeContext(c, deps);
    return c.json(
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const id = uuidParam(c);
        await checkScope(tx, ctx, id);
        return { revision: await portfolioRevision(tx, ctx.tenantId, id) };
      }),
    );
  });
  module.get('/records/:id', async (c) => {
    const ctx = await routeContext(c, deps);
    const value = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const row = await loadContract(tx, ctx.tenantId, uuidParam(c));
      await checkScope(tx, ctx, row.employeeId, row.createdBy);
      return row;
    });
    return c.json(await trim(deps, ctx, CONTRACT_OBJECT, value));
  });
  registerCommands(module, deps);
  registerConfiguration(module, deps);
  registerImports(module, deps);
  registerFailures(module, deps);
  registerMergedTodos(module, deps);
  router.route('/api/tenant/contracts', module);
};
function registerCommands(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.post('/commands', async (c) => {
    const ctx = await routeContext(c, deps, CONTRACT_OBJECT, true);
    const input = parse(commandSchema, await jsonBody(c));
    await checkFields(ctx, input.operation === 'create' ? 'create' : 'update', input.fields);
    await requirePermission(deps.authorize, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: 'object.button',
      resource: buttonResource(
        CONTRACT_OBJECT,
        contractAction(input.operation, input.mode),
        input.operation === 'create' ? 'list' : 'detail',
      ),
    });
    await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const target = input.targetId ? await loadContract(tx, ctx.tenantId, input.targetId) : null;
      await checkScope(tx, ctx, input.employeeId, target?.createdBy);
    });
    return write(c, deps, ctx, input, async (tx, context) => ({
      status: 201,
      body: await createCommand(tx, context, input),
    }));
  });
  module.post('/batch', async (c) => {
    const ctx = await routeContext(c, deps, CONTRACT_OBJECT, true);
    const input = parse(
      z.strictObject({
        items: z
          .array(z.strictObject({ revision: z.int().min(0), command: commandSchema }))
          .min(1)
          .max(100),
      }),
      await jsonBody(c),
    );
    for (const row of input.items) {
      await checkFields(ctx, row.command.operation === 'create' ? 'create' : 'update', row.command.fields);
      await requirePermission(deps.authorize, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: 'object.button',
        resource: buttonResource(
          CONTRACT_OBJECT,
          contractAction(row.command.operation, row.command.mode),
          row.command.operation === 'create' ? 'list' : 'detail',
        ),
      });
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const target = row.command.targetId ? await loadContract(tx, ctx.tenantId, row.command.targetId) : null;
        await checkScope(tx, ctx, row.command.employeeId, target?.createdBy);
      });
    }
    return write(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await batchCommands(tx, context, input.items),
    }));
  });
}
function registerConfiguration(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.get('/settings', async (c) => {
    const ctx = await routeContext(c, deps, 'TenantBase.ContractSettings');
    return c.json(
      await trim(
        deps,
        ctx,
        'TenantBase.ContractSettings',
        await withTenant(deps.db, ctx.tenantId, (tx) => settings(tx, ctx.tenantId)),
      ),
    );
  });
  module.put('/settings', async (c) => {
    const object = 'TenantBase.ContractSettings';
    const ctx = await routeContext(c, deps, object, true);
    const input = (await jsonBody(c)) as Record<string, unknown>;
    await requireObjectWrite(deps.authorize, ctx, { objectCode: object, operation: 'update', payload: input });
    return write(
      c,
      deps,
      ctx,
      input,
      async (tx, ctx) => ({ status: 200, body: await saveSettings(tx, ctx, input) }),
      object,
    );
  });
  module.get('/rules', async (c) => {
    const object = 'TenantBase.ContractRenewalRule';
    const ctx = await routeContext(c, deps, object);
    return c.json(
      await trim(deps, ctx, object, {
        items: await withTenant(deps.db, ctx.tenantId, (tx) => rules(tx, ctx.tenantId)),
      }),
    );
  });
  for (const path of ['/rules', '/rules/:id'])
    module.on(path.endsWith(':id') ? 'PUT' : 'POST', path, async (c) => {
      const object = 'TenantBase.ContractRenewalRule';
      const ctx = await routeContext(c, deps, object, true);
      const input = (await jsonBody(c)) as Record<string, unknown>;
      const id = c.req.param('id') ? uuidParam(c) : undefined;
      await requireObjectWrite(deps.authorize, ctx, {
        objectCode: object,
        operation: id ? 'update' : 'create',
        payload: input,
      });
      return write(
        c,
        deps,
        ctx,
        input,
        async (tx, ctx) => ({ status: id ? 200 : 201, body: await saveRule(tx, ctx, input, id) }),
        object,
      );
    });
  registerMasters(module, deps);
}
function registerMasters(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  for (const kind of ['types', 'companies'] as const) {
    const object = kind === 'types' ? 'TenantBase.ContractType' : 'TenantBase.ContractCompany';
    const table = kind === 'types' ? contractTypes : contractCompanies;
    module.get(`/master-data/${kind}`, async (c) => {
      const ctx = await routeContext(c, deps, object);
      const page = pageQuery(c);
      const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
        tx
          .select()
          .from(table)
          .where(sql`${table.tenantId}=${ctx.tenantId} AND ${ctx.scope?.all ?? false}`)
          .orderBy(table.id)
          .limit(page.limit)
          .offset(page.offset),
      );
      return c.json(await trim(deps, ctx, object, { items }));
    });
    for (const suffix of ['', '/:id'])
      module.on(suffix ? 'PUT' : 'POST', `/master-data/${kind}${suffix}`, async (c) => {
        const ctx = await routeContext(c, deps, object, true);
        const input = (await jsonBody(c)) as Record<string, unknown>;
        await requireObjectWrite(deps.authorize, ctx, {
          objectCode: object,
          operation: suffix ? 'update' : 'create',
          payload: input,
        });
        return write(
          c,
          deps,
          ctx,
          input,
          async (tx, ctx) => ({
            status: suffix ? 200 : 201,
            body: await saveMaster(tx, ctx, kind, input, suffix ? uuidParam(c) : undefined),
          }),
          object,
        );
      });
  }
}
function registerImports(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  for (const suffix of ['', '/preview', '/errors'])
    module.post(`/imports${suffix}`, async (c) => {
      const ctx = await routeContext(c, deps, CONTRACT_OBJECT, true);
      const raw = await jsonBody(c);
      await requirePermission(deps.authorize, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: 'object.button',
        resource: buttonResource(CONTRACT_OBJECT, 'import', 'list'),
      });
      const envelope = parse(importSchema.extend({ rows: z.array(z.unknown()).min(1).max(10000) }), raw);
      const formatting = envelope.rows.flatMap((row, index) => {
        const result = importSchema.shape.rows.element.safeParse(row);
        return result.success ? [] : [{ row: index + 1, code: 'VALIDATION_FAILED', message: '行格式或字段值不合法' }];
      });
      if (suffix === '/errors' && formatting.length) {
        c.header('Content-Type', 'text/csv; charset=utf-8');
        c.header('Content-Disposition', 'attachment; filename="contract-import-errors.csv"');
        return c.body(errorsCsv(formatting));
      }
      const input = parse(importSchema, raw);
      for (const row of input.rows) {
        await checkFields(ctx, ['edit', 'change'].includes(input.mode) ? 'update' : 'create', row.fields);
        await withTenant(deps.db, ctx.tenantId, (tx) => checkScope(tx, ctx, row.employeeId));
      }
      if (input.mode === 'initialize')
        await requirePermission(deps.authorize, {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          action: 'object.delete',
          resource: CONTRACT_OBJECT,
        });
      if (suffix) {
        const result = await withTenant(deps.db, ctx.tenantId, (tx) =>
          previewImport(tx, ctx, input, suffix === '/preview'),
        );
        if (suffix === '/errors') {
          c.header('Content-Type', 'text/csv; charset=utf-8');
          c.header('Content-Disposition', 'attachment; filename="contract-import-errors.csv"');
          return c.body(errorsCsv(result.errors));
        }
        return c.json(result);
      }
      return write(c, deps, ctx, input, async (tx, ctx) => ({
        status: 200,
        body: await importContracts(tx, ctx, input),
      }));
    });
}
function registerFailures(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.post('/requests/:id/cancel', async (c) => {
    const ctx = await routeContext(c, deps, CONTRACT_OBJECT, true);
    const id = uuidParam(c);
    const input = parse(z.strictObject({}), await jsonBody(c));
    await requireObjectWrite(deps.authorize, ctx, { objectCode: CONTRACT_OBJECT, operation: 'update', payload: {} });
    await requirePermission(deps.authorize, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: 'object.button',
      resource: buttonResource(CONTRACT_OBJECT, 'withdraw', 'detail'),
    });
    await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const request = await loadRequest(tx, ctx.tenantId, id);
      await checkScope(tx, ctx, request.employeeId, request.createdBy);
    });
    return write(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await cancelFailedRequest(tx, context, id),
    }));
  });
  module.get('/failures', async (c) => {
    const ctx = await routeContext(c, deps);
    const page = pageQuery(c);
    const { scopeSql } = await import('../permission/module-access.js');
    const predicate = ctx.scope
      ? scopeSql(ctx.scope, {
          person: sql`a.employee_id`,
          creator: sql`CASE WHEN a.kind='activate' THEN (SELECT q.created_by FROM contract_requests q
        WHERE q.tenant_id=a.tenant_id AND q.id=a.object_id) ELSE (SELECT r.created_by FROM contract_records r
        WHERE r.tenant_id=a.tenant_id AND r.id=a.object_id) END`,
        })
      : sql`false`;
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      tx.execute(sql`SELECT a.* FROM contract_job_attempts a
      WHERE a.tenant_id=${ctx.tenantId} AND a.state IN ('failed','unknown') AND ${predicate}
        AND (a.kind<>'activate' OR EXISTS (SELECT 1 FROM contract_requests q
          WHERE q.tenant_id=a.tenant_id AND q.id=a.object_id AND q.status='approved'))
      ORDER BY a.created_at DESC LIMIT ${page.limit} OFFSET ${page.offset}`),
    );
    return c.json({ items: rowsOf(items) });
  });
  module.get('/requests/:id', async (c) => {
    const ctx = await routeContext(c, deps);
    const value = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const request = await loadRequest(tx, ctx.tenantId, uuidParam(c));
      await checkScope(tx, ctx, request.employeeId, request.createdBy);
      return request;
    });
    return c.json(await trim(deps, ctx, CONTRACT_OBJECT, value));
  });
}
