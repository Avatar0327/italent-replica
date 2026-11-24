import { withTenant, type Tx } from '@italent/db';
import { Hono, type Context } from 'hono';
import { runCommand, type CommandResult } from '../../commands.js';
import { policedSub } from '../../route-policy/index.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { pageQuery, parseBody, revision, uuidParam, type BusinessContext } from '../job/context.js';
import { authorizeInTransaction, type ModuleScope } from '../permission/module-access.js';
import {
  requireSchemeOrgs,
  requireSchemeView,
  requireSchemeWrite,
  requireSchemeWriteScope,
  schemeActions,
  schemeScope,
  SCHEME_ROOT,
  type SchemeOperation,
} from './integration-schemes-access.js';
import { schemeCreate, schemeDelete, schemePatch } from './integration-schemes-input.js';
import { INTEGRATION_SCHEME_POLICIES } from './integration-schemes-policy.js';
import { listSchemes, readScheme } from './integration-schemes-read.js';
import { requireSchemeResultScope } from './integration-schemes-result.js';
import { deleteIntegrationScheme, saveIntegrationScheme } from './integration-schemes.js';

type Execute = (tx: Tx, ctx: BusinessContext, scope: ModuleScope) => Promise<unknown>;

async function schemeWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  operation: SchemeOperation,
  prepare: () => Promise<{ input: { orgIds?: readonly string[] | undefined }; execute: Execute }>,
) {
  const tenant = tenantOf(c);
  await requireSchemeWrite(deps.authorize, tenant, operation);
  const expectedRevision = revision(c);
  const { input, execute } = await prepare();
  const deleted = c.req.method === 'DELETE';
  let scope: ModuleScope;
  const result = await runCommand(deps.db, tenant, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: expectedRevision, input },
    guard: {
      async before(tx) {
        scope = await requireSchemeWriteScope(tx, deps, tenant, operation);
        if (input.orgIds) requireSchemeOrgs(scope, input.orgIds);
      },
      replayed: (tx, { body }) => requireSchemeResultScope(tx, tenant.tenantId, scope, body, deleted),
    },
    execute: async (tx, commandId): Promise<CommandResult> => ({
      status: operation === 'create' ? 201 : 200,
      body: await execute(tx, { ...tenant, commandId, expectedRevision, now: deps.clock() }, scope),
    }),
  });
  if (deleted) return c.body(null, 204);
  c.header('ETag', `"${(result.body as { revision: number }).revision}"`);
  return c.json(result.body, result.status);
}

export const registerIntegrationSchemeRoutes: TenantRouteModule = (router, deps) => {
  const module = policedSub(router, INTEGRATION_SCHEME_POLICIES, () => new Hono<TenantEnv>());

  module.get('/schemes', (c) =>
    withTenant(deps.db, tenantOf(c).tenantId, async (tx) => {
      const tenant = tenantOf(c);
      const authorize = authorizeInTransaction(deps.authorize, tx);
      await requireSchemeView(authorize, tenant);
      const scope = await schemeScope(tx, deps, tenant);
      const items = await listSchemes(tx, tenant.tenantId, scope, pageQuery(c));
      const availableActions = scope.all || scope.orgIds.length ? await schemeActions(authorize, tenant, 'create') : [];
      return c.json({ items, availableActions });
    }),
  );
  module.get('/schemes/:id', (c) =>
    withTenant(deps.db, tenantOf(c).tenantId, async (tx) => {
      const tenant = tenantOf(c);
      const id = uuidParam(c);
      const authorize = authorizeInTransaction(deps.authorize, tx);
      await requireSchemeView(authorize, tenant);
      const scope = await schemeScope(tx, deps, tenant);
      const row = await readScheme(tx, tenant.tenantId, scope, id);
      const availableActions = await schemeActions(authorize, tenant, 'update');
      c.header('ETag', `"${row.revision}"`);
      return c.json({ ...row, availableActions });
    }),
  );
  module.post('/schemes', (c) =>
    schemeWrite(c, deps, 'create', async () => {
      const input = await parseBody(c, schemeCreate);
      return { input, execute: (tx, ctx, scope) => saveIntegrationScheme(tx, ctx, scope, { input }) };
    }),
  );
  module.patch('/schemes/:id', (c) =>
    schemeWrite(c, deps, 'update', async () => {
      const id = uuidParam(c);
      const patch = await parseBody(c, schemePatch);
      return { input: patch, execute: (tx, ctx, scope) => saveIntegrationScheme(tx, ctx, scope, { id, patch }) };
    }),
  );
  module.delete('/schemes/:id', (c) =>
    schemeWrite(c, deps, 'update', async () => {
      const id = uuidParam(c);
      const input = c.req.header('content-type') ? await parseBody(c, schemeDelete) : {};
      return { input, execute: (tx, ctx, scope) => deleteIntegrationScheme(tx, ctx, scope, id) };
    }),
  );

  router.route(SCHEME_ROOT, module);
};
