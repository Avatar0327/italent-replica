import { MODULE_OBJECTS } from '@italent/domain';
import { requirePermission, type Authorizer } from '../../authorization.js';
import type { TenantContext } from '../../tenant-context.js';
import { requireObjectWrite } from '../permission/object-write.js';

export const INTEGRATION_POOL_PATH = '/api/tenant/onboarding/integration/task-pool';
export const POOL_SETTINGS = MODULE_OBJECTS.employmentSettings.code;
export const POOL_FIELDS = ['integrationTaskPool'] as const;
export const POOL_WRITE_ALIAS = 'tenant.employment.configuration.write';

export function requirePoolView(authorize: Authorizer, ctx: TenantContext) {
  return requirePermission(authorize, { ...ctx, action: 'object.view', resource: POOL_SETTINGS, fields: POOL_FIELDS });
}

export async function requirePoolWrite(authorize: Authorizer, ctx: TenantContext, operation: 'create' | 'update') {
  await requirePermission(authorize, { ...ctx, action: POOL_WRITE_ALIAS, resource: POOL_SETTINGS });
  await requireObjectWrite(authorize, ctx, {
    objectCode: POOL_SETTINGS,
    operation,
    payload: { integrationTaskPool: true },
  });
}

export async function poolAvailableActions(authorize: Authorizer, ctx: TenantContext, operation: 'create' | 'update') {
  const configured = await authorize({ ...ctx, action: POOL_WRITE_ALIAS, resource: POOL_SETTINGS });
  if (!configured) return [];
  const writable = await authorize({
    ...ctx,
    action: `object.${operation}`,
    resource: POOL_SETTINGS,
    fields: POOL_FIELDS,
  });
  if (!writable) return [];
  return operation === 'create' ? ['create'] : ['edit', 'delete'];
}
