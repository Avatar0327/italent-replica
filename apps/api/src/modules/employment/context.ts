import { auditEvents, sql, withTenant, type Tx } from '@italent/db';
import { buttonResource, tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { requirePermission } from '../../authorization.js';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { businessDate } from './fields.js';
import type { EmploymentContext, EmploymentScope } from './types.js';
import {
  resolveModuleScope,
  getModuleViewableFields,
  trimModuleResponse,
  scopeSql,
  scopeAllows,
  authorizeInTransaction,
  scopeAllowsInTransaction,
} from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { authorizeEmploymentResult } from '../permission/employment-replay.js';
export type { EmploymentContext } from './types.js';
export { pageQuery, revision, uuidParam } from '../job/context.js';

export const EMPLOYEE_OBJECT = 'TenantBase.Employee';
export const EMPLOYMENT_OBJECT = 'TenantBase.EmploymentRecord';

export async function readContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  action: string,
  expectedRevision = 0,
  resource?: string,
  objectCode = EMPLOYMENT_OBJECT,
  pageCode?: string,
): Promise<EmploymentContext> {
  const tenant = tenantOf(c);
  const operation = action === 'tenant.employment.read' ? 'object.view' : action;
  await requirePermission(deps.authorize, {
    ...tenant,
    action: operation,
    resource: objectCode,
    ...(['object.create', 'object.update'].includes(operation) ? { fields: [] } : {}),
  });
  const now = deps.clock();
  const context = { ...tenant, now, expectedRevision, commandId: '' };
  const configuration = ['TenantBase.EmploymentSettings', 'TenantBase.EmploymentCustomField'].includes(objectCode);
  const scope = configuration
    ? undefined
    : await resolveModuleScope(deps, context, tenantLocalDate(now, tenant.timezone), objectCode, pageCode);
  const trustedScopeBypass = await deps.authorize({ ...tenant, action: 'data.scope.all' });
  if (resource && trustedScopeBypass) {
    await requirePermission(deps.authorize, {
      ...tenant,
      action: operation === 'object.view' ? 'tenant.employment.read' : 'tenant.employment.write',
      resource,
    });
  }
  const result = { ...context, scope, authorize: deps.authorize, objectCode, trustedScopeBypass };
  if (resource) {
    const creatorId = await withTenant(deps.db, tenant.tenantId, async (tx) => {
      const creator = await employmentCreatorId(tx, result, resource);
      if (scope && !(await scopeAllowsInTransaction(tx, scope, { personId: resource, creatorId: creator })))
        throw new AppError('NOT_FOUND', '任职数据不存在');
      return creator;
    });
    return { ...result, scopeEmployeeId: resource, scopeEmployeeCreatorId: creatorId };
  }
  return result;
}

export function readPageContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  page: 'list' | 'detail',
  resource?: string,
  objectCode = EMPLOYMENT_OBJECT,
) {
  return readContext(c, deps, 'tenant.employment.read', 0, resource, objectCode, `${objectCode}.${page}`);
}

export function employmentScopePredicate(
  scope: EmploymentScope | undefined,
  person: SQL,
  department?: SQL,
  creator?: SQL,
): SQL {
  return scope
    ? scopeSql(scope, { person, ...(department ? { org: department } : {}), ...(creator ? { creator } : {}) })
    : sql`true`;
}

export function requireEmploymentScope(
  ctx: EmploymentContext,
  employeeId?: string,
  departmentId?: string | null,
  creatorId?: string | null,
) {
  if (!ctx.scope || ctx.scope.all) return;
  const creator =
    creatorId === undefined ? (employeeId === ctx.scopeEmployeeId ? ctx.scopeEmployeeCreatorId : undefined) : creatorId;
  if (
    !employeeId ||
    !scopeAllows(ctx.scope, {
      personId: employeeId,
      ...(creator !== undefined ? { creatorId: creator } : {}),
      ...(departmentId !== undefined ? { orgId: departmentId } : {}),
    })
  )
    throw new AppError('NOT_FOUND', '任职数据不存在');
}

export function employmentCreator(tenantId: string, objectId: SQL, business = false): SQL {
  return sql`(SELECT a.actor_user_id FROM audit_events a WHERE a.tenant_id=${tenantId}
    AND a.object_id=${objectId}::text
    AND a.action=${business ? 'employment.business.create' : 'employment.employee.create'}
    ORDER BY a.occurred_at,a.id LIMIT 1)`;
}

async function employmentCreatorId(tx: Tx, ctx: EmploymentContext, id: string, business = false) {
  if (!ctx.scope?.terms?.some((term) => term.dimension === 'using_user')) return undefined;
  const result = await tx.execute(
    sql`SELECT ${employmentCreator(ctx.tenantId, sql`${id}::uuid`, business)} AS creator`,
  );
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { creator: string | null }[];
  return rows[0]?.creator ?? null;
}

export async function requireScopedEmploymentObject(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  departmentId: string | null,
  businessId?: string,
) {
  if (!ctx.scope || ctx.scope.all) return;
  const creatorId = businessId ? await employmentCreatorId(tx, ctx, businessId, true) : ctx.userId;
  if (!(await scopeAllowsInTransaction(tx, ctx.scope, { personId: employeeId, orgId: departmentId, creatorId })))
    throw new AppError('NOT_FOUND', '任职数据不存在');
}

export async function requireEmploymentWrite(
  ctx: EmploymentContext,
  operation: 'create' | 'update' | 'delete',
  payload: object,
  button?: string,
  objectCode = EMPLOYMENT_OBJECT,
): Promise<void> {
  if (!ctx.authorize) return;
  if (operation === 'delete') {
    await requirePermission(ctx.authorize, { ...ctx, action: 'object.delete', resource: objectCode });
  } else {
    const { fields, customFields, ...metadata } = payload as Record<string, unknown>;
    const actual = {
      ...metadata,
      ...(fields as Record<string, unknown> | undefined),
      ...Object.fromEntries(
        Object.entries((customFields ?? {}) as Record<string, unknown>).map(([id, value]) => [`custom:${id}`, value]),
      ),
    };
    if (!Object.keys(actual).length && !['Employment.Submit', 'Employment.Withdraw'].includes(button ?? '')) {
      throw new AppError('VALIDATION_FAILED', '必须提供要写入的业务字段');
    }
    await requireObjectWrite(ctx.authorize, ctx, { objectCode, operation, payload: actual });
  }
  if (button)
    await requirePermission(ctx.authorize, {
      ...ctx,
      action: 'object.button',
      resource: buttonResource(
        objectCode,
        button,
        ['Employment.Import', 'Employee.Create'].includes(button) ? 'list' : 'detail',
      ),
    });
}

/** TODO(R1-T07, DEC-057)：审批节点详情另按本节点表单裁剪，参与人不获得临时数据范围。 */
export async function trimEmploymentResponse(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  value: unknown,
): Promise<unknown> {
  const objectCode = ctx.objectCode ?? EMPLOYMENT_OBJECT;
  const viewable = await getModuleViewableFields(deps, ctx, objectCode);
  if (viewable === undefined) return value;
  const trim = (record: unknown): unknown => {
    if (Array.isArray(record)) return record.map(trim);
    if (!record || typeof record !== 'object') return record;
    const source = record as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(source)) {
      if (key === 'items') result.items = trim(field);
      else if (key === 'fields' && !Array.isArray(field))
        result.fields = Object.fromEntries(
          Object.entries((field ?? {}) as Record<string, unknown>).filter(([name]) => viewable.has(name)),
        );
      else if (key === 'customFields')
        result.customFields = Object.fromEntries(
          Object.entries((field ?? {}) as Record<string, unknown>).filter(([id]) => viewable.has(`custom:${id}`)),
        );
      else if (key === 'record') result.record = trim(field);
      else if (key === 'before') {
        const before = field as { fields?: { departmentId?: string | null } } | null;
        const allowed =
          !ctx.scope ||
          scopeAllows(ctx.scope, {
            personId: source.employeeId as string | undefined,
            orgId: before?.fields?.departmentId,
          });
        result.before = allowed ? trim(field) : null;
        if (!allowed && Object.hasOwn(source, 'previousRecordId')) result.previousRecordId = null;
      } else if (key === 'changes' && Array.isArray(field))
        result.changes = field.map((change) => {
          const current = change as Record<string, unknown> & { fields?: { field: string }[] };
          return {
            ...Object.fromEntries(
              Object.entries(current).filter(([key]) =>
                key === 'businessId' ? viewable.has('id') : viewable.has(key),
              ),
            ),
            fields: current.fields?.filter((entry) => viewable.has(entry.field.replace(/^preset:/, ''))),
          };
        });
      else if (key === 'skipped' && Array.isArray(field))
        result.skipped = field.map((entry) => {
          const current = entry as Record<string, unknown> & { fields?: string[] };
          return {
            ...Object.fromEntries(
              Object.entries(current).filter(
                ([key]) => key === 'reason' || (key === 'businessId' ? viewable.has('id') : viewable.has(key)),
              ),
            ),
            ...(current.fields
              ? { fields: current.fields.filter((name) => viewable.has(name.replace(/^preset:/, ''))) }
              : {}),
          };
        });
      else if (['notice', 'hasDataPermission', 'page', 'pageSize', 'emptyReason'].includes(key) || viewable.has(key))
        result[key] = field;
    }
    return result;
  };
  // Flat employee/configuration DTOs use the shared helper; nested employment DTOs require field-level traversal.
  return objectCode === EMPLOYMENT_OBJECT
    ? trim(value)
    : trimModuleResponse(deps, ctx, objectCode, value as Record<string, unknown>);
}

export function queryDate(c: Context, ctx: EmploymentContext): string {
  return businessDate(c.req.query('asOf') ?? tenantLocalDate(ctx.now, ctx.timezone));
}

export async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError('VALIDATION_FAILED', '请求必须为合法 JSON');
  }
}

export async function runWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  input: unknown,
  execute: (tx: Tx, context: EmploymentContext) => Promise<CommandResult>,
) {
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input },
    execute: async (tx, commandId) => {
      const commandContext = { ...ctx, commandId, authorize: authorizeInTransaction(deps.authorize, tx) };
      const commandResult = await execute(tx, commandContext);
      // Validate linked writes in the command transaction so an out-of-scope footprint rolls back atomically.
      await authorizeEmploymentResult(tx, commandContext, deps.authorize, commandId, commandResult.body);
      return commandResult;
    },
  });
  await withTenant(deps.db, ctx.tenantId, (tx) =>
    authorizeEmploymentResult(tx, ctx, deps.authorize, c.req.header('idempotency-key')!, result.body),
  );
  const payload = result.body as { revision?: number } | null;
  if (payload?.revision !== undefined) c.header('ETag', `"${payload.revision}"`);
  return c.json(await trimEmploymentResponse(deps, ctx, result.body), result.status);
}

export function assertRevision(expected: number, actual: number): void {
  if (expected !== actual)
    throw new AppError('REVISION_CONFLICT', '任职数据已变更，请刷新后显式重提', { expected, actual });
}

/** DEC-019：字段快照、领域事件和业务写入由同一个租户事务提交。 */
export async function auditEmployment(
  tx: Tx,
  ctx: EmploymentContext,
  action: string,
  objectType: string,
  objectId: string,
  before: unknown,
  after: unknown,
  payloadVersionId?: string,
): Promise<void> {
  await tx.insert(auditEvents).values({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action,
    objectType,
    objectId,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  await tx.execute(sql`
    WITH ownership AS (
      SELECT employee_id, id AS business_id FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND id=${objectId}::uuid
    ), queued AS (
      INSERT INTO employment_outbox(
        tenant_id,employee_id,business_id,event_type,object_type,object_id,command_id,payload,
        payload_version_id,created_at
      )
      SELECT ${ctx.tenantId},ownership.employee_id,ownership.business_id,${action},${objectType},${objectId},
        ${ctx.commandId},${JSON.stringify({ before, after })}::jsonb,${payloadVersionId ?? null}::uuid,
        ${ctx.now.toISOString()}::timestamptz
      FROM (SELECT 1) seed LEFT JOIN ownership ON true RETURNING id
    )
    INSERT INTO employment_outbox_attempts(tenant_id,outbox_id,attempt_no,state,created_at)
    SELECT ${ctx.tenantId},id,1,'pending',${ctx.now.toISOString()}::timestamptz FROM queued
  `);
}
