/**
 * 离职 / 退休时“还没指定接收人”的职责（R2-T09b DT-R4 / DT-R5）：当前承担的职责（与菜单同一取数函数）减去转交计划已覆盖的。
 * 计划的键与菜单职责键同形（下属 = 下属 + 关系，组织角色 = 组织 + 角色），所以直接按 dutyKey 做差。
 */
import type { Tx } from '@italent/db';
import type { LinkageOptions } from '../transfer/linkage/input.js';
import { currentDuties, dutyKey, type Duty } from './duties.js';

type Plan = LinkageOptions['dutyTransfer'];

export function plannedDutyKeys(plan: Plan): Set<string> {
  const keys = new Set<string>();
  for (const item of plan?.subordinates ?? []) keys.add(`sub:${item.employeeId}:${item.relation}`);
  for (const item of plan?.orgRoles ?? []) keys.add(`org:${item.orgId}:${item.role}`);
  return keys;
}

export async function uncoveredDuties(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  asOf: string,
  plan: Plan,
): Promise<Duty[]> {
  const planned = plannedDutyKeys(plan);
  return (await currentDuties(tx, tenantId, employeeId, asOf)).filter((duty) => !planned.has(dutyKey(duty)));
}
