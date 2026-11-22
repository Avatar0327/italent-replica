import { sql, type Tx } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { requirePermission, type Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import type { CommandResultDeps } from '../command-result/registry.js';
import {
  authorizeInTransaction,
  resolveModuleScopeInTransaction,
  scopeAllows,
  scopeSql,
  type ModuleScope,
} from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';

export const SCHEME_ROOT = '/api/tenant/onboarding/integration';
export const SCHEME_PATH = `${SCHEME_ROOT}/schemes`;
export const SCHEME_SETTINGS = MODULE_OBJECTS.employmentSettings.code;
export const SCHEME_SCOPE = MODULE_OBJECTS.onboardingIntegration.code;
export const SCHEME_FIELDS = ['integrationSchemes'] as const;
export const SCHEME_WRITE_ALIAS = 'tenant.employment.configuration.write';
export type SchemeOperation = 'create' | 'update';

export function schemeMissing() {
  return new AppError('NOT_FOUND', '融入方案或配置范围不存在');
}

export async function requireSchemeView(authorize: Authorizer, ctx: TenantContext) {
  await requirePermission(authorize, { ...ctx, action: 'admin.other_settings' });
  await requirePermission(authorize, {
    ...ctx,
    action: 'object.view',
    resource: SCHEME_SETTINGS,
    fields: SCHEME_FIELDS,
  });
}

export async function requireSchemeWrite(authorize: Authorizer, ctx: TenantContext, operation: SchemeOperation) {
  await requirePermission(authorize, { ...ctx, action: SCHEME_WRITE_ALIAS, resource: SCHEME_SETTINGS });
  // 任职设置对象的删除配置沿用编辑权，与任务池一致（DEC-469）。
  await requireObjectWrite(authorize, ctx, {
    objectCode: SCHEME_SETTINGS,
    operation,
    payload: { integrationSchemes: true },
  });
}

export async function schemeScope(tx: Tx, deps: CommandResultDeps, ctx: TenantContext) {
  return resolveModuleScopeInTransaction(deps, ctx, tx, SCHEME_SCOPE);
}

export async function schemeActions(authorize: Authorizer, ctx: TenantContext, operation: SchemeOperation) {
  const writable = await authorize({
    ...ctx,
    action: `object.${operation}`,
    resource: SCHEME_SETTINGS,
    fields: SCHEME_FIELDS,
  });
  if (!writable) return [];
  return operation === 'create' ? ['create'] : ['edit', 'delete'];
}

export async function requireSchemeWriteScope(
  tx: Tx,
  deps: CommandResultDeps,
  ctx: TenantContext,
  operation: SchemeOperation,
) {
  await requireSchemeWrite(authorizeInTransaction(deps.authorize, tx), ctx, operation);
  return schemeScope(tx, deps, ctx);
}

export function requireSchemeOrgs(scope: ModuleScope, ids: readonly string[]) {
  if (!ids.length || ids.some((orgId) => !scopeAllows(scope, { orgId }))) throw schemeMissing();
}

/** 有一个目标组织越界即隐藏整份方案。列表和点查在 SQL 中共用该规则。 */
export function schemeScopeSql(scope: ModuleScope, orgs: SQL) {
  return sql`NOT EXISTS (SELECT 1 FROM ${orgs} AS scheme_org_scope(org_id)
    WHERE NOT ${scopeSql(scope, { org: sql`scheme_org_scope.org_id` })})`;
}
