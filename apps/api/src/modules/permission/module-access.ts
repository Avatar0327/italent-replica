import { sql, type Tx } from '@italent/db';
import { ORG_EMPLOYEE_APP, tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { Authorizer } from '../../authorization.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { EMPTY_SCOPE, type ModuleScope, type ScopeQuery, type ScopeTerm } from './scope-types.js';
export type { ModuleScope } from './scope-types.js';

interface AccessProvider {
  scope(query: ScopeQuery): Promise<ModuleScope>;
  authorize(request: Parameters<Authorizer>[0], tx: Tx): Promise<boolean>;
  fields(tenantId: string, userId: string, objectCode: string): Promise<ReadonlySet<string>>;
}
const providers = new WeakMap<Authorizer, AccessProvider>();
export function registerScopeProvider(authorize: Authorizer, provider: AccessProvider): void {
  providers.set(authorize, provider);
}
export function authorizeInTransaction(authorize: Authorizer, tx: Tx): Authorizer {
  const provider = providers.get(authorize);
  return provider ? (request) => provider.authorize(request, tx) : authorize;
}

type Deps = Pick<TenantRouteDeps, 'authorize' | 'db' | 'clock'>;

/**
 * Current rights also govern historical reads (AGENTS §10). asOf is a business query date,
 * never a client-controlled permission time machine. The raw resolver takes a trusted asOf.
 */
export async function resolveModuleScope(
  deps: Deps,
  ctx: TenantContext,
  _asOf?: string,
  objectCode?: string,
  pageCode?: string,
): Promise<ModuleScope> {
  const provider = providers.get(deps.authorize);
  if (provider)
    return provider.scope({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      appCode: ORG_EMPLOYEE_APP,
      asOf: tenantLocalDate(deps.clock(), ctx.timezone),
      ...(objectCode ? { objectCode } : {}),
      // This API owns both the page and its data source; neither identifier comes from query parameters.
      ...(pageCode ? { pageCode, dataSourceCode: pageCode } : {}),
    });
  // Explicit trusted Authorizer injection is also an authorization boundary. Unset/false is EMPTY.
  const all = await deps.authorize({ ...ctx, action: 'data.scope.all', resource: objectCode ?? ORG_EMPLOYEE_APP });
  return all ? { ...EMPTY_SCOPE, all: true, hasDataPermission: true, source: 'identity' } : EMPTY_SCOPE;
}

export async function getModuleViewableFields(
  deps: Deps,
  ctx: TenantContext,
  objectCode: string,
): Promise<ReadonlySet<string> | undefined> {
  const provider = providers.get(deps.authorize);
  if (provider) return provider.fields(ctx.tenantId, ctx.userId, objectCode);
  return (await deps.authorize({ ...ctx, action: 'data.scope.all', resource: objectCode })) ? undefined : new Set();
}

export async function trimModuleResponse<T extends object>(
  deps: Deps,
  ctx: TenantContext,
  objectCode: string,
  value: T,
): Promise<Partial<T>>;
export async function trimModuleResponse<T extends object>(
  deps: Deps,
  ctx: TenantContext,
  objectCode: string,
  value: T[],
): Promise<Partial<T>[]>;
export async function trimModuleResponse(deps: Deps, ctx: TenantContext, objectCode: string, value: object | object[]) {
  const fields = await getModuleViewableFields(deps, ctx, objectCode);
  if (fields === undefined) return value;
  const trim = (row: object) => Object.fromEntries(Object.entries(row).filter(([field]) => fields.has(field)));
  return Array.isArray(value) ? value.map(trim) : trim(value);
}

function terms(scope: ModuleScope): readonly ScopeTerm[] {
  return scope.terms ?? [{ dimension: 'management', orgIds: scope.orgIds, personIds: scope.personIds }];
}
interface Target {
  readonly orgId?: string | null;
  readonly personId?: string | null;
  readonly creatorId?: string | null;
}
export function scopeAllows(scope: ModuleScope, target: Target): boolean {
  if (scope.all) return true;
  return terms(scope).some((term) => {
    if (term.dimension === 'using_user') return !!target.creatorId && target.creatorId === term.creatorId;
    if (term.dimension === 'reporting') return !!target.personId && term.personIds.includes(target.personId);
    if (term.dimension === 'organization')
      return 'orgId' in target
        ? !!target.orgId && term.orgIds.includes(target.orgId)
        : !!target.personId && term.personIds.includes(target.personId);
    const checks: boolean[] = [];
    if ('orgId' in target) checks.push(!!target.orgId && term.orgIds.includes(target.orgId));
    if ('personId' in target) checks.push(!!target.personId && term.personIds.includes(target.personId));
    return checks.length > 0 && checks.every(Boolean);
  });
}
interface Columns {
  readonly org?: SQL;
  readonly person?: SQL;
  readonly creator?: SQL;
}
const inIds = (column: SQL | undefined, ids: readonly string[]) =>
  column && ids.length ? sql`${column} = ANY(${`{${ids.join(',')}}`}::uuid[])` : sql`false`;
/** SQL-side scope predicates precede LIMIT/OFFSET; no full-tenant result filtering. */
export function scopeSql(scope: ModuleScope, columns: Columns): SQL {
  if (scope.all) return sql`true`;
  const predicates = terms(scope).map((term) => {
    if (term.dimension === 'using_user') {
      return columns.creator && term.creatorId ? sql`${columns.creator} = ${term.creatorId}::uuid` : sql`false`;
    }
    if (term.dimension === 'reporting') return inIds(columns.person, term.personIds);
    if (term.dimension === 'organization')
      return columns.org ? inIds(columns.org, term.orgIds) : inIds(columns.person, term.personIds);
    const both: SQL[] = [];
    if (columns.org) both.push(inIds(columns.org, term.orgIds));
    if (columns.person) both.push(inIds(columns.person, term.personIds));
    return both.length ? sql`(${sql.join(both, sql` AND `)})` : sql`false`;
  });
  return predicates.length ? sql`(${sql.join(predicates, sql` OR `)})` : sql`false`;
}
