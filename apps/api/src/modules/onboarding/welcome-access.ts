import { MODULE_OBJECTS } from '@italent/domain';
import { requirePermission, type Authorizer } from '../../authorization.js';
import type { TenantContext } from '../../tenant-context.js';
import { requireObjectWrite } from '../permission/object-write.js';

export const WELCOME_PATH = '/api/tenant/onboarding/welcome-letters';
export const HANDBOOK_PATH = '/api/tenant/onboarding/handbooks';
export const WELCOME_SETTINGS = MODULE_OBJECTS.employmentSettings.code;
export const WELCOME_WRITE_ALIAS = 'tenant.employment.configuration.write';
export const WELCOME_FIELDS = ['welcomeLetters'] as const;
export const HANDBOOK_FIELDS = ['handbooks'] as const;

type Operation = 'create' | 'update';

/** 配置页设置权仅租户管理员（other_settings），再叠加任职设置对象的字段操作权；两者缺一拒绝。 */
async function requireView(authorize: Authorizer, ctx: TenantContext, fields: readonly string[]) {
  await requirePermission(authorize, { ...ctx, action: 'admin.other_settings' });
  await requirePermission(authorize, { ...ctx, action: 'object.view', resource: WELCOME_SETTINGS, fields });
}

async function requireWrite(authorize: Authorizer, ctx: TenantContext, operation: Operation, field: string) {
  await requirePermission(authorize, { ...ctx, action: WELCOME_WRITE_ALIAS, resource: WELCOME_SETTINGS });
  await requireObjectWrite(authorize, ctx, {
    objectCode: WELCOME_SETTINGS,
    operation,
    payload: { [field]: true },
  });
}

async function availableActions(
  authorize: Authorizer,
  ctx: TenantContext,
  operation: Operation,
  fields: readonly string[],
) {
  const writable = await authorize({ ...ctx, action: `object.${operation}`, resource: WELCOME_SETTINGS, fields });
  if (!writable) return [];
  return operation === 'create' ? ['create'] : ['edit', 'preview', 'delete'];
}

export const requireWelcomeView = (authorize: Authorizer, ctx: TenantContext) =>
  requireView(authorize, ctx, WELCOME_FIELDS);
export const requireWelcomeWrite = (authorize: Authorizer, ctx: TenantContext, operation: Operation) =>
  requireWrite(authorize, ctx, operation, 'welcomeLetters');
export const welcomeAvailableActions = (authorize: Authorizer, ctx: TenantContext, operation: Operation) =>
  availableActions(authorize, ctx, operation, WELCOME_FIELDS);

export const requireHandbookView = (authorize: Authorizer, ctx: TenantContext) =>
  requireView(authorize, ctx, HANDBOOK_FIELDS);
export const requireHandbookWrite = (authorize: Authorizer, ctx: TenantContext, operation: Operation) =>
  requireWrite(authorize, ctx, operation, 'handbooks');
export const handbookAvailableActions = (authorize: Authorizer, ctx: TenantContext, operation: Operation) =>
  availableActions(authorize, ctx, operation, HANDBOOK_FIELDS);
