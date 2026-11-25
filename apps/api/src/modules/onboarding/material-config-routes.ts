import { withTenant, type Tx } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
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
  type ModuleScope,
} from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import {
  lockMaterialConfig,
  materialRuleBody,
  materialRulePatch,
  materialWriteTarget,
  readMaterialRules,
  writeMaterialRule,
} from './material-config.js';
import { MATERIAL_POLICIES } from './policy.js';
import { readEntryMaterials } from './material-list-routes.js';

const SETTINGS = MODULE_OBJECTS.employmentSettings.code;
type Ctx = Context<TenantEnv>;
type Receipt = { id: string; revision: number; status: string };
type Change = Parameters<typeof writeMaterialRule>[3];

async function requireMaterialConfigView(tx: Tx, deps: TenantRouteDeps, ctx: BusinessContext) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  await requirePermission(authorize, { ...ctx, action: 'admin.other_settings' });
  await requirePermission(authorize, { ...ctx, action: 'object.view', resource: SETTINGS, fields: ['materialRules'] });
  const fields = await getModuleViewableFieldsInTransaction(deps, ctx, SETTINGS, tx);
  if (fields && !fields.has('materialRules')) throw new AppError('FORBIDDEN', '没有查看材料规则的权限');
}

async function requireMaterialConfigWrite(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: BusinessContext,
  operation: 'create' | 'update',
) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  await requirePermission(authorize, { ...ctx, action: 'tenant.employment.configuration.write', resource: SETTINGS });
  await requireObjectWrite(authorize, ctx, { objectCode: SETTINGS, operation, payload: { materialRules: true } });
}

async function readConfig(c: Ctx, deps: TenantRouteDeps, id?: string) {
  const ctx = { ...tenantOf(c), expectedRevision: 0, commandId: '', now: deps.clock() };
  const value = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    await requireMaterialConfigView(tx, deps, ctx);
    await lockMaterialConfig(tx, ctx.tenantId, false);
    const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, SETTINGS);
    return readMaterialRules(tx, ctx, scope, pageQuery(c), id);
  });
  if ('revision' in value) c.header('ETag', `"${value.revision}"`);
  return c.json(value);
}

async function writeConfig(c: Ctx, deps: TenantRouteDeps, change: Change, id?: string) {
  const ctx = { ...tenantOf(c), expectedRevision: revision(c), commandId: '', now: deps.clock() };
  // DEC-983：归档沿用编辑权，且 archived 规则仍能用于重放的组织范围复核。
  const operation = id ? 'update' : 'create';
  const status = change === null ? 204 : id ? 200 : 201;
  let scope: ModuleScope;
  let target: Awaited<ReturnType<typeof materialWriteTarget>> | undefined;
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, change },
    guard: {
      before: async (tx) => {
        await requireMaterialConfigWrite(tx, deps, ctx, operation);
        await lockMaterialConfig(tx, ctx.tenantId, true);
        scope = await resolveModuleScopeInTransaction(deps, ctx, tx, SETTINGS);
        if (id) target = await materialWriteTarget(tx, ctx, scope, id);
      },
      replayed: async (tx, stored) => {
        const { receipt } = stored.body as { receipt: Receipt };
        if (!id) await materialWriteTarget(tx, ctx, scope, receipt.id);
      },
    },
    execute: async (tx, commandId) => {
      const receipt = await writeMaterialRule(tx, { ...ctx, commandId }, scope, change, target);
      // F-120 的通用回查只披露最小状态，配置 ID 和版本仅由本路由在当前授权下交付。
      return { status: status as CommandResult['status'], body: { receipt } };
    },
  });
  if (status === 204) return c.body(null, 204);
  const { receipt } = result.body as { receipt: Receipt };
  c.header('ETag', `"${receipt.revision}"`);
  return c.json(receipt, status);
}

export const registerMaterialConfig: TenantRouteModule = (router, deps) => {
  const module = policedSub(router, MATERIAL_POLICIES, () => new Hono<TenantEnv>());
  module.get('/material-rules', (c) => readConfig(c, deps));
  module.get('/material-rules/:id', (c) => readConfig(c, deps, uuidParam(c)));
  module.post('/material-rules', async (c) => writeConfig(c, deps, await parseBody(c, materialRuleBody)));
  module.patch('/material-rules/:id', async (c) =>
    writeConfig(c, deps, await parseBody(c, materialRulePatch), uuidParam(c)),
  );
  module.delete('/material-rules/:id', (c) => writeConfig(c, deps, null, uuidParam(c)));
  module.get('/entries/:businessId/materials', (c) => readEntryMaterials(c, deps));
  router.route('/api/tenant/onboarding', module);
};
