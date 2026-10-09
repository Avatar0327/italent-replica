import { isUuid, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { getEmployee, listEmployees } from '../employment/employees.js';
import { findCurrentRecord } from '../employment/read-model.js';
import type { EmploymentContext, PageQuery } from '../employment/types.js';
import { loadOrgSnapshot } from '../org/read-model.js';
import { EMPTY_SCOPE, type ModuleScope } from '../permission/scope-types.js';

/** DEC-209：只取行政上级链，不扩散到上级的其他下属组织；与提交共用同一个范围。 */
async function managerScope(tx: Tx, tenantId: string, date: string, departmentId?: string) {
  const paths = new Map<string, string>();
  let id = departmentId?.toLowerCase();
  while (id) {
    if (!isUuid(id) || paths.has(id) || paths.size >= 64) return { scope: EMPTY_SCOPE, paths: new Map() };
    const [org] = await loadOrgSnapshot(tx, tenantId, date, undefined, { id, includeDisabled: false });
    if (!org) return { scope: EMPTY_SCOPE, paths: new Map() };
    paths.set(id, org.fullName || org.name);
    id = org.parents.admin?.parentId ?? undefined;
  }
  const orgIds = [...paths.keys()];
  const scope: ModuleScope = {
    ...EMPTY_SCOPE,
    orgIds,
    hasDataPermission: orgIds.length > 0,
    terms: [{ dimension: 'organization', orgIds, personIds: [] }],
  };
  return { scope, paths };
}

export async function managerChoices(
  tx: Tx,
  ctx: EmploymentContext,
  date: string,
  departmentId: string | undefined,
  name: string,
  page: PageQuery,
) {
  const { scope, paths } = await managerScope(tx, ctx.tenantId, date, departmentId);
  const items = await listEmployees(tx, ctx.tenantId, date, page, { status: 'employed', name }, scope);
  return Promise.all(
    items.map(async ({ id, name, avatar }) => {
      const record = await findCurrentRecord(tx, ctx.tenantId, id, date);
      return { id, name, avatar: avatar ?? null, orgPath: paths.get(record?.fields.departmentId ?? '') ?? '' };
    }),
  );
}

export async function requireManagerCandidate(
  tx: Tx,
  ctx: EmploymentContext,
  date: string,
  departmentId: string | undefined,
  managerId: string,
) {
  const { scope } = await managerScope(tx, ctx.tenantId, date, departmentId);
  try {
    const person = await getEmployee(tx, ctx.tenantId, managerId, date, scope);
    if (person.status === 'employed') return;
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'NOT_FOUND') throw error;
  }
  throw new AppError('FORBIDDEN', '新直线经理不在新部门及其上级链的在职员工范围内');
}
