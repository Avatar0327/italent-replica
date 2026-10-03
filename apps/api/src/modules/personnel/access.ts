import type { SQL } from 'drizzle-orm';
import { personnelCreationScope } from '../permission/scope-resolver.js';
import { sql, withTenant, type Tx } from '@italent/db';
import { buttonResource, PERSONNEL_OBJECTS, SUBSETS, tenantLocalDate } from '@italent/domain';
import type { Context } from 'hono';
import { requirePermission, type Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { registerObjectDefinition } from '../permission/catalog.js';
import {
  authorizeInTransaction,
  getModuleViewableFields,
  resolveModuleScope,
  scopeSql,
  type ModuleScope,
} from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { rows, type PersonnelContext, type Row } from './store.js';

for (const object of PERSONNEL_OBJECTS) registerObjectDefinition(object);
export interface AccessContext extends PersonnelContext {
  readonly scope: ModuleScope;
  readonly objectCode: string;
  readonly targetId?: string;
}
export async function access(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  objectCode: string,
  operation: 'view' | 'create' | 'update' | 'delete',
  payload: Row = {},
  button?: string,
  expectedRevision = 0,
  page: 'list' | 'detail' = 'detail',
): Promise<AccessContext> {
  const tenant = tenantOf(c);
  const ctx = { ...tenant, objectCode, expectedRevision, now: deps.clock(), commandId: '' };
  await authorize(deps.authorize, ctx, operation, payload, button);
  let scope = await resolveModuleScope(
    deps,
    ctx,
    undefined,
    objectCode,
    operation === 'view' ? `${objectCode}.${page}` : undefined,
  );
  if (operation === 'create')
    scope = await withTenant(deps.db, ctx.tenantId, (tx) =>
      personnelCreationScope(
        tx,
        { ...ctx, appCode: 'TenantBase', asOf: tenantLocalDate(ctx.now, ctx.timezone) },
        scope,
      ),
    );
  return { ...ctx, scope, ...(c.req.param('id') ? { targetId: c.req.param('id')! } : {}) };
}
export async function authorize(
  authorizer: Authorizer,
  ctx: PersonnelContext & { objectCode: string },
  operation: 'view' | 'create' | 'update' | 'delete',
  payload: Row,
  button?: string,
) {
  if (operation === 'create' || operation === 'update') {
    await requireObjectWrite(authorizer, ctx, { objectCode: ctx.objectCode, operation, payload });
  } else await requirePermission(authorizer, { ...ctx, action: `object.${operation}`, resource: ctx.objectCode });
  if (button)
    await requirePermission(authorizer, {
      ...ctx,
      action: 'object.button',
      resource: buttonResource(ctx.objectCode, button, ['create', 'submit'].includes(button) ? 'list' : 'detail'),
    });
}
export async function authorizeTx(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: AccessContext,
  operation: 'create' | 'update' | 'delete',
  payload: Row,
  button: string,
) {
  await authorize(authorizeInTransaction(deps.authorize, tx), ctx, operation, payload, button);
}
export function personScope(ctx: AccessContext, alias = 'e', creator?: SQL) {
  const subset = Object.values(SUBSETS).find((subset) => subset.objectCode === ctx.objectCode);
  const subsetCreator = subset
    ? sql`(SELECT s.created_by FROM ${sql.identifier(subset.table)} s
    WHERE s.tenant_id=${ctx.tenantId} AND s.employee_id=${sql.identifier(alias)}.id
      AND s.created_by=${ctx.userId} ${ctx.targetId ? sql`AND s.id=${ctx.targetId}::uuid` : sql``} LIMIT 1)`
    : undefined;
  return scopeSql(ctx.scope, {
    person: sql`${sql.identifier(alias)}.id`,
    creator:
      creator ??
      subsetCreator ??
      sql`(SELECT a.actor_user_id FROM audit_events a WHERE a.tenant_id=${ctx.tenantId}
      AND a.object_id=${sql.identifier(alias)}.id::text AND a.action='employment.employee.create'
      ORDER BY a.occurred_at,a.id LIMIT 1)`,
  });
}
export async function requirePerson(tx: Tx, ctx: AccessContext, id: string) {
  const [person] = rows(
    await tx.execute(sql`SELECT e.id FROM employment_employees e
    WHERE e.tenant_id=${ctx.tenantId} AND e.id=${id}::uuid AND ${personScope(ctx)} LIMIT 1`),
  );
  if (!person) throw new AppError('NOT_FOUND', '人员不存在');
}
export async function preflight(deps: TenantRouteDeps, ctx: AccessContext, employeeId: string) {
  await withTenant(deps.db, ctx.tenantId, (tx) => requirePerson(tx, ctx, employeeId));
}
export async function trim(deps: TenantRouteDeps, ctx: PersonnelContext, objectCode: string, value: Row) {
  const fields = await getModuleViewableFields(deps, ctx, objectCode);
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields === undefined || fields.has(key)));
}
