import { sql, type Tx } from '@italent/db';
import { PERSONNEL_OBJECT, tenantLocalDate } from '@italent/domain';
import type { EmployeeStatus } from '../employment/employees.js';
import type { SQL } from 'drizzle-orm';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { AppError } from '../../errors.js';
import { personScope, type AccessContext } from '../personnel/access.js';
import { getModuleViewableFields, resolveModuleScope } from './module-access.js';
import { likePattern } from './enterprise-lists.js';
import { expandScopeRoots, scopeRows } from './scope-hierarchy.js';

export interface ListPersonAccess {
  readonly context: AccessContext;
  readonly fields: ReadonlySet<string> | undefined;
  readonly canView: boolean;
}

/** F-516a：列表新增的档案投影沿用人员对象的当前范围和字段权。 */
export async function listPersonAccess(deps: TenantRouteDeps, ctx: TenantContext): Promise<ListPersonAccess> {
  const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: PERSONNEL_OBJECT });
  const scope = await resolveModuleScope(deps, ctx, undefined, PERSONNEL_OBJECT, `${PERSONNEL_OBJECT}.list`);
  const fields = await getModuleViewableFields(deps, ctx, PERSONNEL_OBJECT);
  return {
    context: { ...ctx, scope, objectCode: PERSONNEL_OBJECT, now: deps.clock(), expectedRevision: 0, commandId: '' },
    fields,
    canView,
  };
}

export function listPersonField(access: ListPersonAccess, field: string): boolean {
  return access.canView && (access.fields === undefined || access.fields.has(field));
}

export function requireListPersonField(access: ListPersonAccess, field: string): void {
  if (!listPersonField(access, field)) throw new AppError('FORBIDDEN', '筛选字段不可查看');
}

/** 当天主职唯一投影，包含向后更新的最新快照，未来任职不提前生效（DEC-889①）。 */
function listPersonSource(access: ListPersonAccess): SQL {
  const ctx = access.context;
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  return sql`SELECT u.user_id,e.id AS employee_id,v.email,v.mobile_phone,
    r.department_id,d.name AS department_name,
    CASE WHEN r.record_id IS NULL OR s.employee_status=1 THEN 'pending' WHEN s.employee_status=8 THEN 'left'
      WHEN s.employee_status=6 THEN 'retired' ELSE 'employed' END AS employee_status
    FROM employment_employees e
    JOIN permission_user_person_links u ON u.tenant_id=e.tenant_id AND u.employee_id=e.id
    LEFT JOIN LATERAL (SELECT v.email,v.mobile_phone FROM personnel_employee_versions v
      WHERE v.tenant_id=e.tenant_id AND v.employee_id=e.id ORDER BY v.revision DESC LIMIT 1) v ON true
    LEFT JOIN LATERAL (
      SELECT r.id AS record_id,CASE WHEN p.id IS NULL THEN r.department_id ELSE p.department_id END AS department_id
      FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      LEFT JOIN LATERAL (SELECT p.id,p.department_id FROM employment_payload_versions p
        WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id
          AND p.is_record_snapshot ORDER BY p.version_no DESC LIMIT 1) p ON true
      WHERE t.tenant_id=e.tenant_id AND t.employee_id=e.id AND t.valid_during @> ${today}::date
        AND r.service_type='primary'
      ORDER BY t.start_date DESC,t.sort_order DESC LIMIT 1
    ) r ON true
    LEFT JOIN LATERAL employment_record_status(e.tenant_id,r.record_id) s ON true
    LEFT JOIN LATERAL (SELECT v.name FROM org_versions v
      WHERE v.tenant_id=e.tenant_id AND v.org_id=r.department_id AND v.start_date<=${today}::date
      ORDER BY v.start_date DESC,v.version_no DESC LIMIT 1) d ON true
    WHERE e.tenant_id=${ctx.tenantId} AND ${access.canView} AND ${personScope(ctx)}`;
}

export interface ListPerson {
  readonly contactEmail?: string | null;
  readonly contactPhone?: string | null;
  readonly employeeStatus?: EmployeeStatus | null;
  readonly department?: { readonly id: string; readonly name: string | null } | null;
}

/** 仅批量读取当前页用户的档案，未绑定或范围外返回空投影。 */
export async function listPersons(tx: Tx, access: ListPersonAccess, userIds: readonly string[]) {
  const result = new Map<string, ListPerson>();
  if (!userIds.length) return result;
  const rows = scopeRows<{
    user_id: string;
    email: string | null;
    mobile_phone: string | null;
    employee_status: EmployeeStatus;
    department_id: string | null;
    department_name: string | null;
  }>(
    await tx.execute(sql`SELECT p.* FROM (${listPersonSource(access)}) p
    WHERE p.user_id=ANY(${`{${userIds.join(',')}}`}::uuid[])`),
  );
  for (const row of rows) {
    result.set(row.user_id, {
      ...(listPersonField(access, 'email') ? { contactEmail: row.email } : {}),
      ...(listPersonField(access, 'mobilePhone') ? { contactPhone: row.mobile_phone } : {}),
      ...(listPersonField(access, 'employeeStatus') ? { employeeStatus: row.employee_status } : {}),
      ...(listPersonField(access, 'orgFullName')
        ? {
            department: row.department_id ? { id: row.department_id, name: row.department_name } : null,
          }
        : {}),
    });
  }
  return result;
}

export async function listDepartmentFilter(tx: Tx, access: ListPersonAccess, userId: object, departmentId: string) {
  requireListPersonField(access, 'orgFullName');
  const ctx = access.context;
  const ids = await expandScopeRoots(tx, ctx.tenantId, tenantLocalDate(ctx.now, ctx.timezone), [
    { orgId: departmentId, dimension: 'admin', includeDescendants: true },
  ]);
  return sql`${userId} IN (SELECT p.user_id FROM (${listPersonSource(access)}) p
    WHERE p.department_id=ANY(${`{${ids.join(',')}}`}::uuid[]))`;
}

/** 联系邮箱独立于既有混合 q，按当前可查看人员筛选，通配符按字面匹配。 */
export function listContactEmailFilter(access: ListPersonAccess, userId: object, email: string): SQL {
  requireListPersonField(access, 'email');
  return listContactEmailMatch(access, userId, email);
}

/** F-516a P2-1：混合 q 只匹配可投影的档案邮箱；不影响姓名、登录邮箱分支。 */
export function listContactEmailMatch(access: ListPersonAccess, userId: object, email: string): SQL {
  if (!listPersonField(access, 'email')) return sql`false`;
  return sql`${userId} IN (SELECT p.user_id FROM (${listPersonSource(access)}) p
    WHERE lower(coalesce(p.email,'')) LIKE ${likePattern(email)})`;
}
