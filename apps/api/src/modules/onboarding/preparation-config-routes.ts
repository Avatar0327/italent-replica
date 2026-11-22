import { onboardingPreparationRules, sql, withTenant, type Tx } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { requirePermission } from '../../authorization.js';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import { policedSub } from '../../route-policy/index.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { pageQuery, parseBody, revision, uuidParam, type BusinessContext } from '../job/context.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
  scopeAllowsInTransaction,
} from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import {
  preparationItemBody,
  preparationItemCreate,
  preparationRuleBody,
  preparationRuleCreate,
} from './preparation-config-input.js';
import {
  preparationConfigScope,
  preparationRuleScope,
  requirePreparationRoots,
  PREPARATION_SETTINGS,
} from './preparation-config-scope.js';
import {
  lockPreparationConfig,
  readPreparationConfig,
  requirePreparationTarget,
  writePreparationConfig,
  type PreparationConfigKind,
  type PreparationWriteScope,
} from './preparation-config.js';
import { PREPARATION_CONFIG_POLICIES } from './preparation-config-policy.js';

type Ctx = Context<TenantEnv>;
type Receipt = Awaited<ReturnType<typeof writePreparationConfig>>;

async function requirePreparationView(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: BusinessContext,
  kind: PreparationConfigKind,
) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  await requirePermission(authorize, { ...ctx, action: 'admin.other_settings' });
  await requirePermission(authorize, { ...ctx, action: 'object.view', resource: PREPARATION_SETTINGS, fields: [kind] });
  const fields = await getModuleViewableFieldsInTransaction(deps, ctx, PREPARATION_SETTINGS, tx);
  if (fields && !fields.has(kind)) throw new AppError('FORBIDDEN', '没有查看此准备配置的权限');
}

async function requirePreparationWrite(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: BusinessContext,
  kind: PreparationConfigKind,
  operation: 'create' | 'update',
) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  await requirePermission(authorize, {
    ...ctx,
    action: 'tenant.employment.configuration.write',
    resource: PREPARATION_SETTINGS,
  });
  await requireObjectWrite(authorize, ctx, { objectCode: PREPARATION_SETTINGS, operation, payload: { [kind]: true } });
}

type Filter = (tx: Tx, ctx: BusinessContext) => Promise<SQL>;
async function readConfig(c: Ctx, deps: TenantRouteDeps, kind: PreparationConfigKind, id?: string, filter?: Filter) {
  const ctx = { ...tenantOf(c), now: deps.clock(), expectedRevision: 0, commandId: '' };
  const value = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    await requirePreparationView(tx, deps, ctx, kind);
    await lockPreparationConfig(tx, ctx.tenantId, 'read');
    return readPreparationConfig(tx, ctx, kind, pageQuery(c), id, await filter?.(tx, ctx));
  });
  if ('revision' in value) c.header('ETag', `"${value.revision}"`);
  return c.json(value);
}

function readRule(c: Ctx, deps: TenantRouteDeps, id?: string) {
  return readConfig(c, deps, 'preparationRules', id, async (tx, ctx) =>
    preparationRuleScope(ctx, await preparationConfigScope(deps, tx, ctx), sql`${onboardingPreparationRules.id}`),
  );
}

type BindScope = (tx: Tx, ctx: BusinessContext) => Promise<PreparationWriteScope>;
function bindPreparationScope(deps: TenantRouteDeps, kind: PreparationConfigKind): BindScope {
  return async (tx, ctx) => {
    const scope = await preparationConfigScope(deps, tx, ctx);
    return {
      target: (id) => requirePreparationTarget(tx, ctx, kind, scope, id),
      orgs: (orgIds) => requirePreparationRoots(tx, ctx, scope, orgIds),
      positionOrg: async (orgId) => {
        const positionScope = await resolveModuleScopeInTransaction(deps, ctx, tx, MODULE_OBJECTS.jobPosition.code);
        return scopeAllowsInTransaction(tx, positionScope, { orgId });
      },
    };
  };
}

async function writeConfig(
  c: Ctx,
  deps: TenantRouteDeps,
  kind: PreparationConfigKind,
  input: object | null,
  id?: string,
  bindScope?: BindScope,
) {
  const ctx = { ...tenantOf(c), now: deps.clock(), expectedRevision: revision(c), commandId: '' };
  const operation = id ? 'update' : 'create';
  const status = input === null ? (204 as CommandResult['status']) : id ? 200 : 201;
  let scope: PreparationWriteScope | undefined;
  let target: Awaited<ReturnType<typeof requirePreparationTarget>> | undefined;
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input },
    guard: {
      before: async (tx) => {
        await requirePreparationWrite(tx, deps, ctx, kind, operation);
        await lockPreparationConfig(tx, ctx.tenantId, 'write');
        scope = await bindScope?.(tx, ctx);
        if (id) target = await scope!.target(id);
      },
      replayed: async (_tx, stored) => {
        if (!id && scope) await scope.target((stored.body as { receipt: Receipt }).receipt.id);
      },
    },
    execute: async (tx, commandId) => {
      const receipt = await writePreparationConfig(tx, { ...ctx, commandId }, kind, input, target, scope);
      // 通用 F-120 只披露固定摘要。包含配置定位信息的回执由本路由授权后返回。
      return { status, body: { receipt } };
    },
  });
  if (input === null) return c.body(null, 204);
  const { receipt } = result.body as { receipt: Receipt };
  c.header('ETag', `"${receipt.revision}"`);
  return c.json(receipt, id ? 200 : 201);
}

const itemPatch = preparationItemBody.partial();
const rulePatch = preparationRuleBody.omit({ itemId: true }).partial();

export const registerPreparationConfig: TenantRouteModule = (router, deps) => {
  const module = policedSub(router, PREPARATION_CONFIG_POLICIES, () => new Hono<TenantEnv>());
  const itemScope = bindPreparationScope(deps, 'preparationItems');
  const ruleScope = bindPreparationScope(deps, 'preparationRules');
  module.get('/preparation-items', (c) => readConfig(c, deps, 'preparationItems'));
  module.get('/preparation-items/:id', (c) => readConfig(c, deps, 'preparationItems', uuidParam(c)));
  module.post('/preparation-items', async (c) =>
    writeConfig(c, deps, 'preparationItems', await parseBody(c, preparationItemCreate)),
  );
  module.patch('/preparation-items/:id', async (c) =>
    writeConfig(c, deps, 'preparationItems', await parseBody(c, itemPatch), uuidParam(c), itemScope),
  );
  module.delete('/preparation-items/:id', (c) =>
    writeConfig(c, deps, 'preparationItems', null, uuidParam(c), itemScope),
  );
  module.get('/preparation-rules', (c) => readRule(c, deps));
  module.get('/preparation-rules/:id', (c) => readRule(c, deps, uuidParam(c)));
  module.post('/preparation-rules', async (c) =>
    writeConfig(c, deps, 'preparationRules', await parseBody(c, preparationRuleCreate), undefined, ruleScope),
  );
  module.patch('/preparation-rules/:id', async (c) =>
    writeConfig(c, deps, 'preparationRules', await parseBody(c, rulePatch), uuidParam(c), ruleScope),
  );
  module.delete('/preparation-rules/:id', (c) =>
    writeConfig(c, deps, 'preparationRules', null, uuidParam(c), ruleScope),
  );
  router.route('/api/tenant/onboarding', module);
};
