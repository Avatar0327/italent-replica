/** DEC-207：导入整批规划员工锁，随后每行复用单条组织变更端口；禁止在组织锁之后补锁。 */
import type { Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { EmploymentContext } from '../employment/types.js';
import {
  lockOrgEmploymentEmployees,
  orgEmploymentTargets,
  ORG_EMPLOYMENT_LIMIT,
  requiresEmploymentChoice,
  type OrgEmploymentBatch,
} from './employment-linkage.js';
import type { OrgImportRow } from './import-service.js';
import { loadOrgSnapshot } from './read-model.js';
import { AppError } from '../../errors.js';

export async function planImportEmployment(
  tx: Tx,
  ctx: EmploymentContext,
  rows: readonly OrgImportRow[],
  mappings: ReadonlyMap<string, string>,
): Promise<OrgEmploymentBatch> {
  const dates = new Set<string>();
  const roots = new Set<string>();
  for (const row of rows) {
    const orgId = mappings.get(row.sourceCode) ?? row.orgId;
    if (!orgId) continue;
    const effectiveDate = row.startDate ?? tenantLocalDate(ctx.now, ctx.timezone);
    const [current] = await loadOrgSnapshot(tx, ctx.tenantId, effectiveDate, undefined, { id: orgId });
    if (!current) continue;
    const patch = { name: row.name, parents: { admin: { parentId: row.parentId } }, effectiveDate };
    if (row.addEmployment === true && requiresEmploymentChoice(current, patch)) {
      dates.add(effectiveDate);
      roots.add(orgId);
    }
    // 前面的行可能把整支子树迁入待联动组织；其员工也必须在批次开始时预锁。
    if (current.parents.admin?.parentId !== row.parentId.toLowerCase()) roots.add(orgId);
  }
  const employeeIds = new Set<string>();
  for (const date of dates) {
    for (const id of await orgEmploymentTargets(tx, ctx, [...roots], date)) employeeIds.add(id);
    if (employeeIds.size > ORG_EMPLOYMENT_LIMIT)
      throw new AppError('PAYLOAD_TOO_LARGE', '整批组织联动人员超过单次处理上限');
  }
  await lockOrgEmploymentEmployees(tx, ctx, [...employeeIds]);
  const rechecked = new Set<string>();
  for (const date of dates) for (const id of await orgEmploymentTargets(tx, ctx, [...roots], date)) rechecked.add(id);
  if (rechecked.size !== employeeIds.size || [...rechecked].some((id) => !employeeIds.has(id)))
    throw new AppError('CONFLICT', '组织联动人员已变化，请刷新后显式重提', { reason: 'ORG_EMPLOYMENT_PLAN_CHANGED' });
  return { employeeIds, remaining: ORG_EMPLOYMENT_LIMIT };
}
