import { sql, type Tx } from '@italent/db';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { rowsOf } from '../employment/read-model.js';
import { loadObjectPermissions } from '../permission/subject.js';

// DEC-205：这是自动员工身份的出厂权限，不是表单白名单。租户可用现有身份配置接口覆盖，另有身份按并集合并。
export const EMPLOYEE_PROFILE_CODE = 'employee_self_service';
const DEFAULT_EDIT = [
  'effectiveDate',
  'reasonCode',
  'departmentId',
  'directManagerId',
  'postId',
  'levelId',
  'sequenceId',
];
const DEFAULT_READ = DEFAULT_EDIT;
export const PROTOCOL_FIELDS = [
  'id',
  'employeeId',
  'revision',
  'employeeRevision',
  'status',
  'kind',
  'stopDate',
  'isCurrent',
  'isLatest',
];

export async function employeeFieldPolicy(tx: Tx, tenantId: string) {
  const [profile] = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT p.id FROM permission_profiles p
    JOIN permission_profile_apps a ON a.tenant_id=p.tenant_id AND a.profile_id=p.id AND a.app_code='TenantBase'
    WHERE p.tenant_id=${tenantId} AND p.code=${EMPLOYEE_PROFILE_CODE}
  `),
  );
  if (!profile) return { view: new Set(DEFAULT_READ), edit: new Set(DEFAULT_EDIT), create: true };
  const [permission] = await loadObjectPermissions(tx, [profile.id], EMPLOYMENT_OBJECT);
  return {
    view: new Set(permission?.fields.filter((field) => field.view).map((field) => field.fieldCode) ?? []),
    edit: new Set(permission?.fields.filter((field) => field.view && field.edit).map((field) => field.fieldCode) ?? []),
    create: permission?.dataOperations.create ?? false,
  };
}
