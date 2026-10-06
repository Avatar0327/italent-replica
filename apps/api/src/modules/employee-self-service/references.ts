import { type Tx } from '@italent/db';
import type { TenantRouteDeps } from '../../routes.js';
import { AppError } from '../../errors.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { employeeName, listEmployees } from '../employment/employees.js';
import { businessDate } from '../employment/fields.js';
import type { EmploymentContext, PageQuery } from '../employment/types.js';
import { loadJobObject, listJobObjects } from '../job/read-model.js';
import type { JobKind } from '../job/metadata.js';
import { loadOrgSnapshot } from '../org/read-model.js';
import { resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { readTransferSettings } from '../transfer/configuration.js';
import { transferFieldAccess } from './access.js';
import { managerChoices } from '../transfer/employee-managers.js';
import { EMPLOYEE_READONLY_FIELDS } from './policy.js';

const JOB_FIELDS: Record<string, JobKind> = {
  positionId: 'positions',
  postId: 'posts',
  levelId: 'levels',
  gradeId: 'grades',
  sequenceId: 'sequences',
  professionalLineId: 'professional-lines',
};
const PERSON_FIELDS = new Set(['directManagerId', 'dottedManagerId', 'addedSubordinateIds']);

/** 仅接受可信原值、服务端带出值或已通过候选校验的值，不能直接传入客户端字段。 */
export async function referenceLabels(tx: Tx, ctx: EmploymentContext, fields: Record<string, unknown>, date: string) {
  const labels: Record<string, string> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) continue;
    if (field === 'departmentId')
      labels[field] = (await loadOrgSnapshot(tx, ctx.tenantId, date, undefined, { id: value }))[0]?.name ?? '';
    else if (JOB_FIELDS[field])
      labels[field] = (await loadJobObject(tx, ctx.tenantId, JOB_FIELDS[field], value, date))?.name ?? '';
    else if (PERSON_FIELDS.has(field)) labels[field] = await employeeName(tx, ctx.tenantId, value);
  }
  return labels;
}

/** DEC-209：经理走新部门上级链；员工只读职务字典不开放候选。 */
export async function referenceChoices(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  code: string,
  date: string,
  name: string,
  page: PageQuery,
  departmentId?: string,
) {
  businessDate(date);
  if (!(await transferFieldAccess(tx, deps, ctx)).has(code)) throw new AppError('FORBIDDEN', '无权查看此字段');
  if (EMPLOYEE_READONLY_FIELDS.has(code)) return [];
  if (code === 'directManagerId') return managerChoices(tx, ctx, date, departmentId, name, page);
  const objectCode = EMPLOYMENT_OBJECT;
  const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, objectCode, `${objectCode}.detail`);
  if (PERSON_FIELDS.has(code)) {
    const items = await listEmployees(tx, ctx.tenantId, date, page, { status: 'employed', name }, scope);
    return items.map(({ id, name }) => ({ id, name }));
  }
  if (code === 'departmentId') {
    const settings = await readTransferSettings(tx, ctx.tenantId);
    const items = await loadOrgSnapshot(tx, ctx.tenantId, date, page, {
      includeDisabled: false,
      ...(settings.unrestrictTargetDepartment ? {} : { scope }),
    });
    return items.map(({ id, fullName, name, parents, level }) => ({
      id,
      name: fullName || name,
      parentId: parents.admin?.parentId ?? null,
      level,
    }));
  }
  const kind = JOB_FIELDS[code];
  if (!kind) throw new AppError('VALIDATION_FAILED', '字段不是引用字段');
  // 字典对象沿用其自身的数据范围，不能把员工自助的本人范围当作字典看全部。
  const jobObjects: Record<string, string> = {
    positions: 'TenantBase.Position',
    posts: 'TenantBase.JobPost',
    levels: 'TenantBase.JobLevel',
    grades: 'TenantBase.JobGrade',
    sequences: 'TenantBase.JobSequence',
    'professional-lines': 'TenantBase.JobProfessionalLine',
  };
  const jobScope = await resolveModuleScopeInTransaction(deps, ctx, tx, jobObjects[kind]!, `${jobObjects[kind]}.list`);
  const items = await listJobObjects(tx, ctx.tenantId, kind, {
    ...page,
    asOf: date,
    enabled: true,
    scope: jobScope,
    ...(name ? { name } : {}),
  });
  return items.map(({ id, name }) => ({ id, name }));
}
