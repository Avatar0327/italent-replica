import { withTenant, type Tx } from '@italent/db';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import { policedSub } from '../../route-policy/index.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { pageQuery, parseBody, revision, uuidParam } from '../job/context.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import {
  INTEGRATION_POOL_PATH,
  poolAvailableActions,
  requirePoolView,
  requirePoolWrite,
} from './integration-pool-access.js';
import { integrationPoolOptions, poolCategory, poolCreateBody, poolPatchBody } from './integration-pool-input.js';
import { INTEGRATION_POOL_POLICIES } from './integration-pool-policy.js';
import {
  createIntegrationPoolTask,
  deleteIntegrationPoolTask,
  listIntegrationPoolTasks,
  poolTaskView,
  readIntegrationPoolTask,
  updateIntegrationPoolTask,
} from './integration-pool.js';

const emptyDeleteBody = z.strictObject({});

function poolQuery(c: Context<TenantEnv>) {
  const rawCategory = poolCategory.optional().safeParse(c.req.query('category'));
  const enabled = c.req.query('enabled');
  if (!rawCategory.success || (enabled !== undefined && enabled !== 'true' && enabled !== 'false'))
    throw new AppError('VALIDATION_FAILED', '融入任务类别或启停筛选不合法');
  return {
    ...pageQuery(c),
    category: rawCategory.data,
    enabled: enabled === undefined ? undefined : enabled === 'true',
  };
}

async function poolWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  operation: 'create' | 'update',
  prepare: (expectedRevision: number) => Promise<{
    input: unknown;
    execute: (tx: Tx, commandId: string) => Promise<CommandResult>;
  }>,
) {
  const tenant = tenantOf(c);
  await requirePoolWrite(deps.authorize, tenant, operation);
  const expectedRevision = revision(c);
  const { input, execute } = await prepare(expectedRevision);
  return runCommand(deps.db, tenant, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: expectedRevision, input },
    guard: {
      before: (tx) => requirePoolWrite(authorizeInTransaction(deps.authorize, tx), tenant, operation),
    },
    execute,
  });
}

function poolContext(c: Context<TenantEnv>, deps: TenantRouteDeps, expectedRevision: number, commandId: string) {
  return { ...tenantOf(c), now: deps.clock(), expectedRevision, commandId };
}

function poolWriteResponse(c: Context<TenantEnv>, result: CommandResult) {
  c.header('ETag', `"${(result.body as { revision: number }).revision}"`);
  return c.json(result.body, result.status);
}

export const registerIntegrationPoolRoutes: TenantRouteModule = (router, deps) => {
  const module = policedSub(router, INTEGRATION_POOL_POLICIES, () => new Hono<TenantEnv>());

  module.get('/categories', (c) =>
    withTenant(deps.db, tenantOf(c).tenantId, async (tx) => {
      await requirePoolView(authorizeInTransaction(deps.authorize, tx), tenantOf(c));
      return c.json(integrationPoolOptions());
    }),
  );
  module.get('/', (c) =>
    withTenant(deps.db, tenantOf(c).tenantId, async (tx) => {
      const tenant = tenantOf(c);
      const authorize = authorizeInTransaction(deps.authorize, tx);
      await requirePoolView(authorize, tenant);
      const rows = await listIntegrationPoolTasks(tx, tenant.tenantId, poolQuery(c));
      const availableActions = await poolAvailableActions(authorize, tenant, 'create');
      return c.json({ items: rows.map((row) => poolTaskView(row)), availableActions });
    }),
  );
  module.get('/:id', (c) =>
    withTenant(deps.db, tenantOf(c).tenantId, async (tx) => {
      const tenant = tenantOf(c);
      const id = uuidParam(c);
      const authorize = authorizeInTransaction(deps.authorize, tx);
      await requirePoolView(authorize, tenant);
      const row = await readIntegrationPoolTask(tx, tenant.tenantId, id);
      const availableActions = await poolAvailableActions(authorize, tenant, 'update');
      c.header('ETag', `"${row.revision}"`);
      return c.json({ ...poolTaskView(row), availableActions });
    }),
  );

  module.post('/', async (c) => {
    const result = await poolWrite(c, deps, 'create', async (expectedRevision) => {
      const input = await parseBody(c, poolCreateBody);
      return {
        input,
        execute: async (tx, commandId) => ({
          status: 201,
          body: await createIntegrationPoolTask(tx, poolContext(c, deps, expectedRevision, commandId), input),
        }),
      };
    });
    return poolWriteResponse(c, result);
  });
  module.patch('/:id', async (c) => {
    const id = uuidParam(c);
    const result = await poolWrite(c, deps, 'update', async (expectedRevision) => {
      const input = await parseBody(c, poolPatchBody);
      return {
        input,
        execute: async (tx, commandId) => ({
          status: 200,
          body: await updateIntegrationPoolTask(tx, poolContext(c, deps, expectedRevision, commandId), id, input),
        }),
      };
    });
    return poolWriteResponse(c, result);
  });
  module.delete('/:id', async (c) => {
    const id = uuidParam(c);
    await poolWrite(c, deps, 'update', async (expectedRevision) => {
      if (c.req.raw.body !== null && c.req.header('content-length') !== '0') await parseBody(c, emptyDeleteBody);
      return {
        input: null,
        execute: async (tx, commandId) => ({
          // 命令台账存最小删除回执，HTTP 首次与重放均返回无正文的 204。
          status: 200,
          body: await deleteIntegrationPoolTask(tx, poolContext(c, deps, expectedRevision, commandId), id),
        }),
      };
    });
    return c.body(null, 204);
  });

  router.route(INTEGRATION_POOL_PATH, module);
};
