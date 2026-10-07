/**
 * 设计 §2.5（S1-P2-02 / S2-P2-02）：前序因迟到区间内含某条后序而记 REBUILD_REQUIRED 时，那条后序可以先顺延落地——
 * 但只在两笔之间没有跨对象联动依赖时成立。两笔触及同一个下属（新增下属 / 职责转交）、同一个组织角色（部门负责人 /
 * 店长 / 转交的组织角色）、同一份合同或兼职记录，倒序执行会互相覆盖对方写到第三方对象上的结果，这时维持 DEC-112
 * 前序门禁（后笔挂起），由 HR 处理，F-036 接管重建。
 */
import { sql, type Tx } from '@italent/db';
import { latestLinkage } from '../transfer/linkage/store.js';
import { isRebuildBlocker, type PendingActivation } from './activation-store.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

function uuidList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string');
  if (typeof value === 'string' && value.startsWith('{')) return value.slice(1, -1).split(',').filter(Boolean);
  return [];
}

/** 一笔调动会改写的第三方对象集合（联动足迹）：按最新载荷与最新联动版本计算。 */
export async function linkageFootprint(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const [payload] = rowsOf<{ head: boolean | null; store: boolean | null; dept: string | null; subs: unknown }>(
    await tx.execute(sql`
    SELECT is_department_head AS head, is_store_manager AS store, department_id AS dept,
      added_subordinate_ids AS subs
    FROM employment_payload_versions WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid
    ORDER BY version_no DESC LIMIT 1`),
  );
  for (const id of uuidList(payload?.subs)) keys.add(`employee:${id}`);
  if (payload?.head && payload.dept) keys.add(`role:person_in_charge@${payload.dept}`);
  if (payload?.store && payload.dept) keys.add(`role:shop_owner@${payload.dept}`);
  const options = (await latestLinkage(tx, ctx.tenantId, businessId))?.options;
  for (const item of options?.dutyTransfer?.subordinates ?? []) keys.add(`employee:${item.employeeId}`);
  for (const item of options?.dutyTransfer?.orgRoles ?? []) keys.add(`role:${item.role}@${item.orgId}`);
  if (options?.contract) keys.add(`contract:${options.contract.targetId}`);
  for (const item of options?.partTimes ?? []) keys.add(`partTime:${item.recordId}`);
  return keys;
}

/** 两笔调动的联动足迹是否相交（有先后依赖，不能倒序执行）。 */
export async function linkageDependent(tx: Tx, ctx: EmploymentContext, a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([linkageFootprint(tx, ctx, a), linkageFootprint(tx, ctx, b)]);
  for (const key of first) if (second.has(key)) return true;
  return false;
}

/** 前序 REBUILD_REQUIRED 失败把本业务记为 blocker，且两者没有跨对象联动依赖 → 本业务不因这次失败挂起或被拒。 */
export async function exemptsBlocker(
  tx: Tx,
  ctx: EmploymentContext,
  predecessor: PendingActivation,
  businessId: string,
): Promise<boolean> {
  if (!isRebuildBlocker(predecessor, businessId)) return false;
  return !(await linkageDependent(tx, ctx, predecessor.id, businessId));
}

/** 仍约束本业务的前序：去掉只提醒的，以及按上述规则豁免的。 */
export async function blockingPredecessors(
  tx: Tx,
  ctx: EmploymentContext,
  before: readonly PendingActivation[],
  businessId: string,
): Promise<PendingActivation[]> {
  const blocking: PendingActivation[] = [];
  for (const item of before) {
    if (item.reminderOnly || (await exemptsBlocker(tx, ctx, item, businessId))) continue;
    blocking.push(item);
  }
  return blocking;
}
