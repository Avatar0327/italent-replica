/**
 * 设计 §2.5（S1-P2-02 / S2-P2-02 / S3-P2-01 / S3-P2-02）：前序因迟到区间内含某条后序而记 REBUILD_REQUIRED 时，那条后序
 * 可以先顺延落地——但只在两笔之间没有跨对象联动依赖时成立。两笔触及同一个下属（新增下属 / 职责转交）、同一个组织角色
 * （部门负责人 / 店长 / 转交的组织角色）、同一份合同或兼职记录，倒序执行会互相覆盖对方写到第三方对象上的结果，这时维持
 * DEC-112 前序门禁（后笔挂起），由 HR 处理，F-036 接管重建。
 * 足迹按落地时实际使用的有效字段计算：已落地的业务读任职记录（与 transfer-linkage.ts 的 applyTransferLinkage 同一口径，
 * 延迟继承的部门已解析）；未落地的申请读最新载荷，部门为空（生效时才继承）时该角色按“可能依赖”处理。
 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { latestLinkage } from '../transfer/linkage/store.js';
import { activationPredecessors, isRebuildBlocker, type PendingActivation } from './activation-store.js';
import { loadEmploymentRecord } from './read-model.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

function uuidList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string');
  if (typeof value === 'string' && value.startsWith('{')) return value.slice(1, -1).split(',').filter(Boolean);
  return [];
}

interface FootprintFields {
  readonly head: boolean | null;
  readonly store: boolean | null;
  /** 有效部门；未落地且延迟继承时为空（S3-P2-02：生效时才解析，按“可能依赖”登记通配角色键）。 */
  readonly dept: string | null;
  readonly subs: readonly string[];
}

/** 足迹输入里只有部门会在落地时才解析（INHERITED_FIELDS 不含两个角色标志与新增下属；联动选项都是显式 ID）。 */
async function footprintFields(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<FootprintFields> {
  const record = await loadEmploymentRecord(tx, ctx.tenantId, businessId, tenantLocalDate(ctx.now, ctx.timezone));
  if (record) {
    const { isDepartmentHead, isStoreManager, departmentId, addedSubordinateIds } = record.fields;
    return { head: isDepartmentHead, store: isStoreManager, dept: departmentId, subs: addedSubordinateIds ?? [] };
  }
  const [payload] = rowsOf<{ head: boolean | null; store: boolean | null; dept: string | null; subs: unknown }>(
    await tx.execute(sql`
    SELECT is_department_head AS head, is_store_manager AS store, department_id AS dept,
      added_subordinate_ids AS subs
    FROM employment_payload_versions WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid
    ORDER BY version_no DESC LIMIT 1`),
  );
  return {
    head: payload?.head ?? null,
    store: payload?.store ?? null,
    dept: payload?.dept ?? null,
    subs: uuidList(payload?.subs),
  };
}

/** 组织角色键 `role:<角色>@<组织>`；部门尚未解析时组织为 `*`，与任何部门的同名角色都算相交。 */
const roleKey = (role: string, orgId: string | null) => `role:${role}@${orgId ?? '*'}`;
const ROLE_WILDCARD = /^role:([^@]+)@\*$/;

/** 一笔调动会改写的第三方对象集合（联动足迹）：按有效字段与最新联动版本计算。 */
export async function linkageFootprint(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const fields = await footprintFields(tx, ctx, businessId);
  for (const id of fields.subs) keys.add(`employee:${id}`);
  if (fields.head) keys.add(roleKey('person_in_charge', fields.dept));
  if (fields.store) keys.add(roleKey('shop_owner', fields.dept));
  const options = (await latestLinkage(tx, ctx.tenantId, businessId))?.options;
  for (const item of options?.dutyTransfer?.subordinates ?? []) keys.add(`employee:${item.employeeId}`);
  for (const item of options?.dutyTransfer?.orgRoles ?? []) keys.add(roleKey(item.role, item.orgId));
  if (options?.contract) keys.add(`contract:${options.contract.targetId}`);
  for (const item of options?.partTimes ?? []) keys.add(`partTime:${item.recordId}`);
  return keys;
}

function matchesWildcard(key: string, other: ReadonlySet<string>): boolean {
  const wildcard = ROLE_WILDCARD.exec(key);
  if (!wildcard) return false;
  const prefix = `role:${wildcard[1]}@`;
  for (const candidate of other) if (candidate.startsWith(prefix)) return true;
  return false;
}

/** 两笔调动的联动足迹是否相交（有先后依赖，不能倒序执行）；通配角色键与任何同名角色相交。 */
export async function linkageDependent(tx: Tx, ctx: EmploymentContext, a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([linkageFootprint(tx, ctx, a), linkageFootprint(tx, ctx, b)]);
  for (const key of first) if (second.has(key) || matchesWildcard(key, second)) return true;
  for (const key of second) if (matchesWildcard(key, first)) return true;
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

/** 仍约束本业务的前序：去掉只提醒的，以及按上述规则豁免的。被挂起的前序不豁免（它自己还没判定过与本业务的先后）。 */
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

/**
 * 生效前的前序复核（DEC-108 / DEC-112）：申请的 activate 端口（transitions.ts）与已落地直接调动的联动落地
 * （activation-checks.ts）同一套——队列里排在本业务之前、仍约束它的业务未落地时不得越过（S3-P2-01）。
 */
export async function assertPredecessorsSettled(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  businessId: string,
): Promise<void> {
  const { before } = await activationPredecessors(tx, ctx, employeeId, businessId);
  const blocking = await blockingPredecessors(tx, ctx, before, businessId);
  if (blocking.length)
    throw new AppError('CONFLICT', '前序待生效业务尚未生效', {
      reason: 'ACTIVATION_PREDECESSOR_PENDING',
      blockedByBusinessId: blocking[0]!.id,
    });
}
