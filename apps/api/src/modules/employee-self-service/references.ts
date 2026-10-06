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

const JOB_FIELDS: Record<string, JobKind> = {
  positionId: 'positions',
  postId: 'posts',
  levelId: 'levels',
  gradeId: 'grades',
  sequenceId: 'sequences',
  professionalLineId: 'professional-lines',
};
const PERSON_FIELDS = new Set(['directManagerId', 'dottedManagerId', 'addedSubordinateIds']);

/** 只解析本人任职中已有的引用；不提供按任意 ID 读取他人档案的端点。 */
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

/** TODO(需取证 #81)：纯员工选择器范围尚未确证，沿用当前 HR 候选范围；默认空，不授予全租户人员范围。 */
export async function referenceChoices(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  code: string,
  date: string,
  name: string,
  page: PageQuery,
) {
  businessDate(date);
  if (!(await transferFieldAccess(tx, deps, ctx)).has(code)) throw new AppError('FORBIDDEN', '无权查看此字段');
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
