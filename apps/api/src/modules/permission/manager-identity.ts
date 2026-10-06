/** Q-M0-71：负责人自助是即时派生身份，不写授权行，不改变用户 × 应用的显式范围。 */
import { sql, type Tx } from '@italent/db';
import { MODULE_OBJECTS, type GrantedObjectPermission } from '@italent/domain';
import { scopeRows, expandScopeRoots } from './scope-hierarchy.js';
import { currentPersons } from './scope-persons.js';

export const MANAGER_PROFILE_CODE = 'department_manager_self_service';
export interface ManagerQuery {
  tenantId: string;
  userId: string;
  asOf: string;
}

export async function managerIdentity(tx: Tx, q: ManagerQuery) {
  const [binding] = scopeRows<{ employeeId: string }>(
    await tx.execute(sql`
    SELECT l.employee_id AS "employeeId" FROM permission_user_person_links l
    JOIN tenant_memberships m ON m.tenant_id=l.tenant_id AND m.user_id=l.user_id AND m.status='active'
    WHERE l.tenant_id=${q.tenantId} AND l.user_id=${q.userId}::uuid LIMIT 1
  `),
  );
  if (!binding) return { active: false, employeeId: null, orgIds: [] as string[], rootIds: [] as string[] };
  const roots = scopeRows<{ id: string }>(
    await tx.execute(sql`
    SELECT org_id AS id FROM (SELECT DISTINCT ON (org_id) org_id,person_in_charge_id
      FROM org_versions WHERE tenant_id=${q.tenantId} AND start_date<=${q.asOf}::date AND enabled
      ORDER BY org_id,start_date DESC,version_no DESC) v
    WHERE person_in_charge_id=${binding.employeeId}::uuid LIMIT 201
  `),
  );
  const orgIds = await expandScopeRoots(
    tx,
    q.tenantId,
    q.asOf,
    roots.map((r) => ({ orgId: r.id, dimension: 'admin', includeDescendants: true })),
  );
  const reports = scopeRows(
    await tx.execute(sql`
    SELECT 1 FROM (${currentPersons(q.tenantId, q.asOf)}) p
    WHERE p.direct_manager_id=${binding.employeeId}::uuid AND p.employee_id<>${binding.employeeId}::uuid
      AND p.kind NOT IN ('leave','retirement') LIMIT 1
  `),
  );
  return {
    active: roots.length > 0 || reports.length > 0,
    employeeId: binding.employeeId,
    orgIds,
    rootIds: roots.map((r) => r.id),
  };
}

/** 默认值是身份配置的后备；租户创建同编码身份后，完全使用其对象/字段配置，不叠加默认字段。 */
export function defaultManagerPermissions(): GrantedObjectPermission[] {
  const editable = new Set([
    'kind',
    'mode',
    'initiator',
    'transferTypeCode',
    'reasonCode',
    'effectiveDate',
    'formId',
    'directManagerId',
    'postId',
  ]);
  const viewable = new Set([
    ...editable,
    'id',
    'revision',
    'employeeId',
    'employeeRevision',
    'status',
    'entryDate',
    'serviceType',
    'createdAt',
    'updatedAt',
  ]);
  return [
    {
      objectCode: MODULE_OBJECTS.employmentRecord.code,
      profileApps: ['TenantBase'],
      dataOperations: { create: true, update: true, delete: false },
      fields: MODULE_OBJECTS.employmentRecord.fields.map((f) => ({
        fieldCode: f.code,
        view: viewable.has(f.code),
        edit: editable.has(f.code),
      })),
      buttons: ['Transfer.Manager', 'Employment.Preview', 'Employment.Submit'].map((buttonCode) => ({
        buttonCode,
        level: 'detail' as const,
      })),
    },
    {
      objectCode: MODULE_OBJECTS.employee.code,
      profileApps: ['TenantBase'],
      dataOperations: { create: false, update: false, delete: false },
      fields: MODULE_OBJECTS.employee.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
      buttons: [],
    },
  ];
}
