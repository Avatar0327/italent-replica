import { sql, withTenant, type Tx } from '@italent/db';
import type { Context } from 'hono';
import type { Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { rowsOf } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  registerScopeProvider,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { EMPTY_SCOPE } from '../permission/scope-types.js';
import { employeeFieldPolicy, PROTOCOL_FIELDS } from './policy.js';

const COMMAND_FIELDS = new Set(['initiator', 'transferTypeCode', 'formId', 'mode', 'kind', 'submit']);
const BUTTONS = new Set(['Transfer.Self', 'Employment.Create', 'Employment.Submit']);

export async function boundEmployee(tx: Tx, ctx: Pick<EmploymentContext, 'tenantId' | 'userId'>) {
  const [employee] = rowsOf<{ id: string; name: string; code: string; revision: number }>(
    await tx.execute(sql`
    SELECT e.id,e.name,e.code,e.revision FROM permission_user_person_links l
    JOIN employment_employees e ON e.tenant_id=l.tenant_id AND e.id=l.employee_id
    WHERE l.tenant_id=${ctx.tenantId} AND l.user_id=${ctx.userId}::uuid
  `),
  );
  if (!employee) throw new AppError('FORBIDDEN', '当前用户未绑定员工');
  return employee;
}

/** 只供本人路由使用，不给 HR / 审批接口增加任何隐式授权或租户范围。 */
export async function selfAccess(c: Context<TenantEnv>, deps: TenantRouteDeps, expectedRevision = 0) {
  const tenant = tenantOf(c);
  const employee = await withTenant(deps.db, tenant.tenantId, (tx) => boundEmployee(tx, tenant));
  const scope = {
    ...EMPTY_SCOPE,
    hasDataPermission: true,
    personIds: [employee.id],
    terms: [{ dimension: 'reporting' as const, orgIds: [], personIds: [employee.id] }],
  };
  const check = async (tx: Tx) => {
    if ((await boundEmployee(tx, tenant)).id !== employee.id) throw new AppError('FORBIDDEN', '员工绑定已变化，请刷新');
  };
  const evaluate = async (request: Parameters<Authorizer>[0], tx: Tx) => {
    const base = authorizeInTransaction(deps.authorize, tx);
    if (request.tenantId !== tenant.tenantId || request.userId !== tenant.userId) return base(request);
    await check(tx);
    if (request.resource?.split('#')[0] !== EMPLOYMENT_OBJECT) return base(request);
    if (request.action === 'object.view') return true;
    if (request.action === 'object.button') {
      const button = request.resource?.split('#')[1]?.split('@')[0] ?? '';
      return BUTTONS.has(button) || base(request);
    }
    if (['object.create', 'object.update'].includes(request.action) && request.fields) {
      const policy = await employeeFieldPolicy(tx, tenant.tenantId);
      if (!policy.create && !(await base({ ...request, fields: [] }))) return false;
      for (const field of request.fields) {
        if ((policy.create && policy.edit.has(field)) || COMMAND_FIELDS.has(field)) continue;
        if (!(await base({ ...request, fields: [field] }))) return false;
      }
      return true;
    }
    return base(request);
  };
  const authorize: Authorizer = (request) => withTenant(deps.db, tenant.tenantId, (tx) => evaluate(request, tx));
  const fields = async (tenantId: string, userId: string, objectCode: string, tx: Tx) => {
    const existing = await getModuleViewableFieldsInTransaction(deps, { ...tenant, tenantId, userId }, objectCode, tx);
    if (tenantId !== tenant.tenantId || userId !== tenant.userId || objectCode !== EMPLOYMENT_OBJECT)
      return existing ?? new Set<string>();
    await check(tx);
    return new Set([...PROTOCOL_FIELDS, ...(await employeeFieldPolicy(tx, tenantId)).view, ...(existing ?? [])]);
  };
  registerScopeProvider(authorize, {
    authorize: evaluate,
    fields: (tenantId, userId, objectCode, tx) =>
      tx
        ? fields(tenantId, userId, objectCode, tx)
        : withTenant(deps.db, tenantId, (t) => fields(tenantId, userId, objectCode, t)),
    scope: async (query, tx) => {
      const resolve = async (t: Tx) => {
        await check(t);
        if (
          query.tenantId === tenant.tenantId &&
          query.userId === tenant.userId &&
          query.objectCode === EMPLOYMENT_OBJECT
        )
          return scope;
        return resolveModuleScopeInTransaction(
          deps,
          { ...tenant, tenantId: query.tenantId, userId: query.userId },
          t,
          query.objectCode ?? '',
          query.pageCode ?? '',
        );
      };
      return tx ? resolve(tx) : withTenant(deps.db, tenant.tenantId, resolve);
    },
  });
  const ctx: EmploymentContext = {
    selfServiceEmployeeId: employee.id,
    ...tenant,
    now: deps.clock(),
    expectedRevision,
    commandId: '',
    objectCode: EMPLOYMENT_OBJECT,
    scope,
    authorize,
  };
  return { employee, ctx, deps: { ...deps, authorize }, check };
}

export type SelfAccess = Awaited<ReturnType<typeof selfAccess>>;

export async function transferFieldAccess(tx: Tx, deps: TenantRouteDeps, ctx: EmploymentContext) {
  const granted = await getModuleViewableFieldsInTransaction(deps, ctx, EMPLOYMENT_OBJECT, tx);
  return new Set([...(await employeeFieldPolicy(tx, ctx.tenantId)).view, ...(granted ?? [])]);
}
