import { withTenant, type Tx } from '@italent/db';
import { Hono, type Context } from 'hono';
import { requirePermission } from '../../authorization.js';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import { policedSub } from '../../route-policy/index.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { pageQuery, parseBody, revision, uuidParam, type BusinessContext } from '../job/context.js';
import { authorizeInTransaction, getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { ruleBody, rulePatch, settingsBody, templateBody, templatePatch } from './collection-config-input.js';
import { collectionScope, SETTINGS } from './collection-config-scope.js';
import {
  lockCollectionConfig,
  readCollectionConfig,
  requireCollectionTarget,
  saveCollectionSettings,
  writeCollectionResource,
  type CollectionConfigKind,
} from './collection-config.js';
import { COLLECTION_CONFIG_POLICIES } from './policy.js';

type Ctx = Context<TenantEnv>;
type Resource = Exclude<CollectionConfigKind, 'collectionSettings'>;
type Mode = 'view' | 'create' | 'update';

async function requireConfigPermission(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: BusinessContext,
  kind: CollectionConfigKind,
  operation: Mode,
) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  await requirePermission(authorize, { ...ctx, action: 'tenant.employment.configuration.write', resource: SETTINGS });
  await requirePermission(authorize, { ...ctx, action: `object.${operation}`, resource: SETTINGS, fields: [kind] });
  if (operation === 'view') {
    const fields = await getModuleViewableFieldsInTransaction(deps, ctx, SETTINGS, tx);
    if (fields && !fields.has(kind)) throw new AppError('FORBIDDEN', '没有查看此采集配置的权限');
  }
}

function configContext(c: Ctx, deps: TenantRouteDeps, expectedRevision = 0): BusinessContext {
  return { ...tenantOf(c), expectedRevision, commandId: '', now: deps.clock() };
}

async function readConfig(c: Ctx, deps: TenantRouteDeps, kind: CollectionConfigKind, id?: string) {
  const ctx = configContext(c, deps);
  const value = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    await requireConfigPermission(tx, deps, ctx, kind, 'view');
    await lockCollectionConfig(tx, ctx.tenantId, 'read');
    const scope = await collectionScope(deps, tx, ctx);
    return readCollectionConfig(tx, { ctx, scope }, kind, pageQuery(c), id);
  });
  if ('revision' in value) c.header('ETag', `"${value.revision}"`);
  return c.json(value);
}

type Receipt = { id: string; revision: number; status: string };
type Change =
  | { kind: Resource; input: object | null; id?: string }
  | { kind: 'collectionSettings'; input: { enabled: boolean }; id?: never };

async function writeConfig(c: Ctx, deps: TenantRouteDeps, change: Change) {
  const ctx = configContext(c, deps, revision(c));
  const { kind, id, input } = change;
  const operation = c.req.method === 'POST' ? 'create' : 'update';
  const archive = c.req.method === 'DELETE';
  // runCommand 的类型以非空响应为主。归档台账仍记真实 HTTP 状态，出口按 204 发送空正文。
  const status = archive ? (204 as CommandResult['status']) : operation === 'create' ? 201 : 200;
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input },
    guard: {
      before: async (tx) => {
        await requireConfigPermission(tx, deps, ctx, kind, operation);
        await lockCollectionConfig(tx, ctx.tenantId, 'write');
        if (id) await requireCollectionTarget(tx, { ctx, scope: await collectionScope(deps, tx, ctx) }, kind, id);
      },
      replayed: async (tx, stored) => {
        const { receipt } = stored.body as { receipt: Receipt };
        if (!id && kind !== 'collectionSettings')
          await requireCollectionTarget(tx, { ctx, scope: await collectionScope(deps, tx, ctx) }, kind, receipt.id);
      },
    },
    execute: async (tx, commandId) => {
      const current = { ...ctx, commandId };
      const receipt =
        change.kind === 'collectionSettings'
          ? await saveCollectionSettings(tx, current, change.input.enabled)
          : await writeCollectionResource(
              tx,
              { ctx: current, scope: await collectionScope(deps, tx, ctx) },
              change.kind,
              change.input,
              id,
            );
      // F-120 固定摘要只取顶层业务 ID 与版本。资源回执只经本路由当前授权后披露。
      return { status, body: { receipt } };
    },
  });
  if (archive) return c.body(null, 204);
  const { receipt } = result.body as { receipt: Receipt };
  c.header('ETag', `"${receipt.revision}"`);
  return c.json(receipt, operation === 'create' ? 201 : 200);
}

export const registerCollectionConfig: TenantRouteModule = (router, deps) => {
  const module = policedSub(router, COLLECTION_CONFIG_POLICIES, () => new Hono<TenantEnv>());
  module.get('/collection-templates', (c) => readConfig(c, deps, 'collectionTemplates'));
  module.get('/collection-templates/:id', (c) => readConfig(c, deps, 'collectionTemplates', uuidParam(c)));
  module.post('/collection-templates', async (c) =>
    writeConfig(c, deps, { kind: 'collectionTemplates', input: await parseBody(c, templateBody) }),
  );
  module.patch('/collection-templates/:id', async (c) =>
    writeConfig(c, deps, { kind: 'collectionTemplates', id: uuidParam(c), input: await parseBody(c, templatePatch) }),
  );
  module.delete('/collection-templates/:id', (c) =>
    writeConfig(c, deps, { kind: 'collectionTemplates', id: uuidParam(c), input: null }),
  );
  module.get('/collection-rules', (c) => readConfig(c, deps, 'collectionRules'));
  module.get('/collection-rules/:id', (c) => readConfig(c, deps, 'collectionRules', uuidParam(c)));
  module.post('/collection-rules', async (c) =>
    writeConfig(c, deps, { kind: 'collectionRules', input: await parseBody(c, ruleBody) }),
  );
  module.patch('/collection-rules/:id', async (c) =>
    writeConfig(c, deps, { kind: 'collectionRules', id: uuidParam(c), input: await parseBody(c, rulePatch) }),
  );
  module.delete('/collection-rules/:id', (c) =>
    writeConfig(c, deps, { kind: 'collectionRules', id: uuidParam(c), input: null }),
  );
  module.get('/collection-settings', (c) => readConfig(c, deps, 'collectionSettings'));
  module.put('/collection-settings', async (c) =>
    writeConfig(c, deps, { kind: 'collectionSettings', input: await parseBody(c, settingsBody) }),
  );
  router.route('/api/tenant/onboarding', module);
};
