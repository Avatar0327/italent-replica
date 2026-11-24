import { onboardingCollectionRules, sql, withTenant, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { requirePermission } from '../../authorization.js';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import { policedSub } from '../../route-policy/index.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { pageQuery, parseBody, revision, uuidParam, type BusinessContext } from '../job/context.js';
import { authorizeInTransaction, getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { ruleBody, rulePatch, settingsBody, templateBody, templatePatch } from './collection-config-input.js';
import { collectionScope, requireCollectionOrgScope, ruleScopeSql, SETTINGS } from './collection-config-scope.js';
import {
  lockCollectionConfig,
  readCollectionConfig,
  requireCollectionTarget,
  saveCollectionSettings,
  writeCollectionResource,
  type CollectionConfigKind,
  type CollectionWriteScope,
} from './collection-config.js';
import { COLLECTION_CONFIG_POLICIES } from './policy.js';

type Ctx = Context<TenantEnv>;
type Resource = Exclude<CollectionConfigKind, 'collectionSettings'>;

async function requireConfigView(tx: Tx, deps: TenantRouteDeps, ctx: BusinessContext, kind: CollectionConfigKind) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  await requirePermission(authorize, { ...ctx, action: 'admin.other_settings' });
  await requirePermission(authorize, { ...ctx, action: 'object.view', resource: SETTINGS, fields: [kind] });
  const fields = await getModuleViewableFieldsInTransaction(deps, ctx, SETTINGS, tx);
  if (fields && !fields.has(kind)) throw new AppError('FORBIDDEN', '没有查看此采集配置的权限');
}

async function requireConfigWrite(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: BusinessContext,
  kind: CollectionConfigKind,
  operation: 'create' | 'update',
) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  await requirePermission(authorize, { ...ctx, action: 'tenant.employment.configuration.write', resource: SETTINGS });
  await requireObjectWrite(authorize, ctx, { objectCode: SETTINGS, operation, payload: { [kind]: true } });
}

function configContext(c: Ctx, deps: TenantRouteDeps, expectedRevision = 0): BusinessContext {
  return { ...tenantOf(c), expectedRevision, commandId: '', now: deps.clock() };
}

type RuleFilter = (tx: Tx, ctx: BusinessContext) => Promise<SQL>;

async function readConfig(c: Ctx, deps: TenantRouteDeps, kind: CollectionConfigKind, id?: string, filter?: RuleFilter) {
  const ctx = configContext(c, deps);
  const value = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    await requireConfigView(tx, deps, ctx, kind);
    await lockCollectionConfig(tx, ctx.tenantId, 'read');
    return readCollectionConfig(tx, ctx, kind, pageQuery(c), id, await filter?.(tx, ctx));
  });
  if ('revision' in value) c.header('ETag', `"${value.revision}"`);
  return c.json(value);
}

function readRule(c: Ctx, deps: TenantRouteDeps, id?: string) {
  return readConfig(c, deps, 'collectionRules', id, async (tx, ctx) =>
    ruleScopeSql(ctx, await collectionScope(deps, tx, ctx), sql`${onboardingCollectionRules.id}`),
  );
}

type BindWriteScope = (tx: Tx, ctx: BusinessContext) => Promise<CollectionWriteScope>;
function bindCollectionWriteScope(deps: TenantRouteDeps, kind: Resource): BindWriteScope {
  return async (tx, ctx) => {
    const scope = await collectionScope(deps, tx, ctx);
    return {
      target: (id) => requireCollectionTarget(tx, { ctx, scope }, kind, id),
      orgs: (orgIds) => requireCollectionOrgScope(tx, ctx, scope, orgIds),
    };
  };
}

type Receipt = { id: string; revision: number; status: string };
type Change =
  | { kind: Resource; input: object | null; id?: string }
  | { kind: 'collectionSettings'; input: { enabled: boolean }; id?: never };

async function writeConfig(c: Ctx, deps: TenantRouteDeps, change: Change, bindScope?: BindWriteScope) {
  const ctx = configContext(c, deps, revision(c));
  const { kind, id, input } = change;
  const operation = c.req.method === 'POST' ? 'create' : 'update';
  const archive = c.req.method === 'DELETE';
  // runCommand 的类型以非空响应为主。归档台账仍记真实 HTTP 状态，出口按 204 发送空正文。
  const status = archive ? (204 as CommandResult['status']) : operation === 'create' ? 201 : 200;
  let scope: CollectionWriteScope | undefined;
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input },
    guard: {
      before: async (tx) => {
        await requireConfigWrite(tx, deps, ctx, kind, operation);
        await lockCollectionConfig(tx, ctx.tenantId, 'write');
        scope = await bindScope?.(tx, ctx);
        if (id) await scope!.target(id);
      },
      replayed: async (_tx, stored) => {
        const { receipt } = stored.body as { receipt: Receipt };
        if (!id && scope) await scope.target(receipt.id);
      },
    },
    execute: async (tx, commandId) => {
      const current = { ...ctx, commandId };
      const receipt =
        change.kind === 'collectionSettings'
          ? await saveCollectionSettings(tx, current, change.input.enabled)
          : await writeCollectionResource(tx, current, change.kind, change.input, id, scope);
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
  const templateScope = bindCollectionWriteScope(deps, 'collectionTemplates');
  const ruleScope = bindCollectionWriteScope(deps, 'collectionRules');
  module.get('/collection-templates', (c) => readConfig(c, deps, 'collectionTemplates'));
  module.get('/collection-templates/:id', (c) => readConfig(c, deps, 'collectionTemplates', uuidParam(c)));
  module.post('/collection-templates', async (c) =>
    writeConfig(c, deps, { kind: 'collectionTemplates', input: await parseBody(c, templateBody) }),
  );
  module.patch('/collection-templates/:id', async (c) =>
    writeConfig(
      c,
      deps,
      { kind: 'collectionTemplates', id: uuidParam(c), input: await parseBody(c, templatePatch) },
      templateScope,
    ),
  );
  module.delete('/collection-templates/:id', (c) =>
    writeConfig(c, deps, { kind: 'collectionTemplates', id: uuidParam(c), input: null }, templateScope),
  );
  module.get('/collection-rules', (c) => readRule(c, deps));
  module.get('/collection-rules/:id', (c) => readRule(c, deps, uuidParam(c)));
  module.post('/collection-rules', async (c) =>
    writeConfig(c, deps, { kind: 'collectionRules', input: await parseBody(c, ruleBody) }, ruleScope),
  );
  module.patch('/collection-rules/:id', async (c) =>
    writeConfig(
      c,
      deps,
      { kind: 'collectionRules', id: uuidParam(c), input: await parseBody(c, rulePatch) },
      ruleScope,
    ),
  );
  module.delete('/collection-rules/:id', (c) =>
    writeConfig(c, deps, { kind: 'collectionRules', id: uuidParam(c), input: null }, ruleScope),
  );
  module.get('/collection-settings', (c) => readConfig(c, deps, 'collectionSettings'));
  module.put('/collection-settings', async (c) =>
    writeConfig(c, deps, { kind: 'collectionSettings', input: await parseBody(c, settingsBody) }),
  );
  router.route('/api/tenant/onboarding', module);
};
