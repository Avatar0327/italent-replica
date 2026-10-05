import type { Tx } from '@italent/db';
import { loadOrgSnapshot } from '../org/read-model.js';
import type { PresetFields } from '../employment/types.js';

/** 08 附表 W-013：选新部门后带出负责人，部门未设负责人时沿行政上级查找。 */
export async function managerForTransferDepartment(
  tx: Tx,
  tenantId: string,
  fields: Partial<PresetFields>,
  effectiveDate: string,
): Promise<string | null | undefined> {
  if (!fields.departmentId || Object.hasOwn(fields, 'directManagerId')) return undefined;
  let id: string | null = fields.departmentId;
  const visited = new Set<string>();
  while (id && !visited.has(id) && visited.size < 100) {
    visited.add(id);
    const [org] = await loadOrgSnapshot(tx, tenantId, effectiveDate, undefined, { id, includeDisabled: false });
    if (!org) return null;
    if (org.personInChargeId) return org.personInChargeId;
    id = org.parents.admin?.parentId ?? null;
  }
  return null;
}
